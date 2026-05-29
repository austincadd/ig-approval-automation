import 'dotenv/config';
import dns from 'node:dns';
import { spawnSync } from 'node:child_process';
import express from 'express';
import path from 'node:path';
import Database from 'better-sqlite3';
import TelegramBot from 'node-telegram-bot-api';
import { acquireSingleInstanceLock } from './single-instance.js';
import { registerCallbackHandlers } from './callback-routing.js';
import { createReviewCardService } from './review-card-service.js';
import { registerStoryCandidateCommands } from './story-candidate-commands.js';
import { registerOperatorTelegramCommands } from './operator-telegram-commands.js';
import { registerOperatorHttpRoutes } from './operator-http-routes.js';
import { registerTelegramMessageIntake } from './telegram-message-intake.js';
import { createCommandTaskRunner } from './command-task-runner.js';
import { createControlPlaneAuth } from './control-plane-auth.js';
import { createTelegramResultReporter } from './telegram-result-reporter.js';
import { classifyTelegramError, createTelegramTransportHealthStore } from './telegram-transport-health.js';
import { runSelfTests } from '../core/self-tests.js';

dns.setDefaultResultOrder('ipv4first');


function launchctlDomain(label) {
  return typeof process.getuid === 'function' ? `gui/${process.getuid()}/${label}` : label;
}

function kickstartLaunchdService(label) {
  const normalized = String(label || '').trim();
  if (!normalized) return { ok: false, skipped: true, reason: 'missing_label' };
  const result = spawnSync('launchctl', ['kickstart', '-k', launchctlDomain(normalized)], {
    encoding: 'utf8',
    timeout: 5000
  });
  if (result.error) {
    return { ok: false, error: result.error.message, stdout: result.stdout || '', stderr: result.stderr || '' };
  }
  return {
    ok: result.status === 0,
    code: result.status,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
    label: normalized
  };
}

function buildRemediationContext(db) {
  const workerLabel = process.env.WORKER_LAUNCHD_LABEL || 'com.austincaddell.ig-approval-worker';
  const controlPlaneLabel = process.env.CONTROL_PLANE_LAUNCHD_LABEL || '';
  return {
    actions: {
      restartWorker: async () => kickstartLaunchdService(workerLabel),
      restartControlPlane: controlPlaneLabel ? async () => kickstartLaunchdService(controlPlaneLabel) : undefined,
      runSelfTests: async () => {
        const result = await runSelfTests(db, { enableBrowserProbe: false });
        return { ok: result.summary?.overall !== 'error', summary: result.summary, result };
      },
      reprobeQueue: async () => {
        const result = await runSelfTests(db, { enableBrowserProbe: false });
        return { ok: result.summary?.overall !== 'error', summary: result.summary, result };
      }
    }
  };
}


export function registerCallbackServerComposition({
  app,
  bot,
  db,
  chatId,
  controlGuards,
  reviewCardService,
  commandHelpers,
  startResultReporter
}) {
  const {
    isAuthorizedActor,
    isAuthorizedControlRequest,
    rejectUnauthorizedControlRequest
  } = controlGuards;
  const {
    getCandidateForReview,
    handleAction,
    isValidCallbackAction,
    sendReviewBatch,
    sendReviewCard
  } = reviewCardService;
  const {
    requireAuthorizedChat,
    enqueueCommandTask,
    runRepoCommand
  } = commandHelpers;

  registerCallbackHandlers({
    app,
    bot,
    isAuthorizedActor,
    isAuthorizedControlRequest,
    rejectUnauthorizedControlRequest,
    isValidCallbackAction,
    handleAction
  });

  startResultReporter();

  registerTelegramMessageIntake({
    bot,
    db,
    chatId,
    isAuthorizedActor,
    getCandidateForReview,
    sendReviewCard
  });

  const storyCandidateCommands = registerStoryCandidateCommands({
    bot,
    db,
    chatId,
    requireAuthorizedChat,
    enqueueCommandTask,
    runRepoCommand
  });

  registerOperatorTelegramCommands({
    bot,
    db,
    chatId,
    requireAuthorizedChat
  });

  registerOperatorHttpRoutes({
    app,
    db,
    isAuthorizedControlRequest,
    rejectUnauthorizedControlRequest,
    sendReviewBatch,
    remediationContext: buildRemediationContext(db)
  });

  return {
    closeResources: storyCandidateCommands?.closeResources || (async () => {})
  };
}

const db = new Database(path.resolve('data/ig_automation.db'));
const app = express();
app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: false }));

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const controlToken = (process.env.TELEGRAM_CONTROL_TOKEN || '').trim();
const bindHost = (process.env.TELEGRAM_CALLBACK_BIND_HOST || '127.0.0.1').trim() || '127.0.0.1';
const lockPath = (process.env.TELEGRAM_BOT_LOCK_PATH || 'data/telegram-bot.lock').trim() || 'data/telegram-bot.lock';
const resultPollMs = Math.max(1000, Number(process.env.TELEGRAM_RESULT_POLL_MS || 5000));

if (!token || !chatId) {
  console.error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');
  process.exit(1);
}

const transportHealth = createTelegramTransportHealthStore(db);
let instanceLock;
try {
  instanceLock = acquireSingleInstanceLock({
    lockPath,
    label: 'telegram bot/callback server',
    metadata: { bindHost, cwd: process.cwd() }
  });
} catch (error) {
  if (error?.code === 'SINGLE_INSTANCE_ACTIVE') {
    transportHealth.writeTransportHealth({
      status: 'fatal',
      duplicatePollerDetected: true,
      lastError: error.message
    });
    console.error(`[system] ${error.message}`);
    process.exit(1);
  }
  console.error('[system] failed to acquire single-instance lock', error);
  process.exit(1);
}

const bot = new TelegramBot(token, {
  polling: {
    interval: 300,
    autoStart: true,
    params: { timeout: 30 }
  }
});

const auth = createControlPlaneAuth({ chatId, controlToken, bindHost });
const commands = createCommandTaskRunner({ repoCwd: path.resolve('.') });
const reviewCardService = createReviewCardService({ db, bot, chatId });

let pollingRestartAttempts = 0;
let pollingRestartTimer = null;
let shuttingDown = false;
let consecutiveSendFailures = 0;
transportHealth.writeTransportHealth({ status: 'ok', duplicatePollerDetected: false, restartAttempts: 0 });

async function safeSendMessage(message) {
  try {
    await bot.sendMessage(chatId, message);
    consecutiveSendFailures = 0;
    transportHealth.writeTransportHealth({ status: pollingRestartAttempts > 0 ? 'degraded' : 'ok', sendFailures: 0, lastError: null });
    return true;
  } catch (err) {
    consecutiveSendFailures += 1;
    transportHealth.writeTransportHealth({
      status: 'degraded',
      sendFailures: consecutiveSendFailures,
      lastError: err?.message || String(err)
    });
    console.error('[telegram] send_failed', err?.message || err);
    return false;
  }
}

const resultReporter = createTelegramResultReporter({
  db,
  safeSendMessage,
  writeTransportHealth: transportHealth.writeTransportHealth,
  pollMs: resultPollMs
});

function schedulePollingRestart(reason = 'unknown') {
  if (pollingRestartTimer) return;
  const delayMs = Math.min(30000, 1500 * (2 ** pollingRestartAttempts));
  pollingRestartAttempts = Math.min(pollingRestartAttempts + 1, 8);
  transportHealth.writeTransportHealth({
    status: 'degraded',
    restartAttempts: pollingRestartAttempts,
    lastError: reason
  });
  console.warn(`[telegram] scheduling polling restart in ${delayMs}ms; reason=${reason}`);
  pollingRestartTimer = setTimeout(async () => {
    pollingRestartTimer = null;
    try { await bot.stopPolling(); } catch {}
    try {
      await bot.startPolling();
      pollingRestartAttempts = 0;
      transportHealth.writeTransportHealth({ status: 'ok', restartAttempts: 0, lastError: null });
      console.log('[telegram] polling restarted successfully');
    } catch (err) {
      transportHealth.writeTransportHealth({ status: 'degraded', lastError: err?.message || String(err) });
      console.error('[telegram] polling restart failed', err?.message || err);
      schedulePollingRestart('restart_failed');
    }
  }, delayMs);
}

bot.on('polling_error', (err) => {
  const info = classifyTelegramError(err);
  const current = transportHealth.readTransportHealth();
  transportHealth.writeTransportHealth({
    status: info.duplicate ? 'fatal' : 'degraded',
    duplicatePollerDetected: info.duplicate,
    pollingErrors: Number(current.pollingErrors || 0) + 1,
    lastError: err?.message || String(err)
  });
  console.error('[telegram] polling_error', err?.code || '', err?.message || err);
  if (info.duplicate) return void gracefulShutdown('TELEGRAM_DUPLICATE_POLLER', 1);
  if (info.transient) schedulePollingRestart('polling_error_transient');
});

bot.on('webhook_error', (err) => {
  transportHealth.writeTransportHealth({ status: 'degraded', lastError: err?.message || String(err) });
  console.error('[telegram] webhook_error', err?.code || '', err?.message || err);
});

bot.on('error', (err) => {
  const info = classifyTelegramError(err);
  transportHealth.writeTransportHealth({
    status: info.duplicate ? 'fatal' : 'degraded',
    duplicatePollerDetected: info.duplicate,
    lastError: err?.message || String(err)
  });
  console.error('[telegram] bot_error', err?.code || '', err?.message || err);
  if (info.duplicate) return void gracefulShutdown('TELEGRAM_DUPLICATE_POLLER', 1);
  if (info.transient) schedulePollingRestart('bot_error_transient');
});

const { closeResources } = registerCallbackServerComposition({
  app,
  bot,
  db,
  chatId,
  controlGuards: {
    isAuthorizedActor: auth.isAuthorizedActor,
    isAuthorizedControlRequest: auth.isAuthorizedControlRequest,
    rejectUnauthorizedControlRequest: auth.rejectUnauthorizedControlRequest
  },
  reviewCardService: {
    getCandidateForReview: reviewCardService.getCandidateForReview,
    handleAction: reviewCardService.handleAction,
    isValidCallbackAction: reviewCardService.isValidCallbackAction,
    sendReviewBatch: reviewCardService.sendReviewBatch,
    sendReviewCard: reviewCardService.sendReviewCard
  },
  commandHelpers: {
    requireAuthorizedChat: auth.requireAuthorizedChat,
    enqueueCommandTask: commands.enqueueCommandTask,
    runRepoCommand: commands.runRepoCommand
  },
  startResultReporter: () => resultReporter.start()
});

const port = 8788;
const server = app.listen(port, bindHost, () => {
  console.log(`Callback server listening on ${bindHost}:${port}`);
  console.log(`Single-instance lock: ${instanceLock.path}`);
  console.log('POST /review/push to send candidate cards');
});

server.on('error', (error) => {
  if (error?.code === 'EADDRINUSE') {
    transportHealth.writeTransportHealth({
      status: 'fatal',
      duplicatePollerDetected: true,
      lastError: `callback server port ${bindHost}:${port} already in use`
    });
    console.error(`[system] callback server port ${bindHost}:${port} is already in use. Another instance may still be running outside the lock path (${instanceLock.path}).`);
  }
  void gracefulShutdown('SERVER_ERROR');
});

async function gracefulShutdown(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[system] ${signal} received, shutting down...`);
  try { if (pollingRestartTimer) clearTimeout(pollingRestartTimer); } catch {}
  try { resultReporter.stop(); } catch {}
  try { await bot.stopPolling(); } catch {}
  try { await closeResources(); } catch {}
  try { server.close(); } catch {}
  try { instanceLock?.release(); } catch {}
  process.exit(exitCode);
}

process.on('SIGINT', () => { void gracefulShutdown('SIGINT'); });
process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM'); });
process.on('exit', () => {
  try { instanceLock?.release(); } catch {}
});
