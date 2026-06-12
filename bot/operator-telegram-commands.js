import {
  pauseAutomation,
  resumeAutomation,
  requeueBlockedJobs,
  reconcileApprovedQueue
} from '../core/recovery.js';
import { formatOperatorAutomationStatus, getOperatorAutomationStatus } from '../core/automation-status.js';
import { formatRecoverySummary } from './recovery-command-format.js';
import { acknowledgeSessionChallenge, acknowledgeSessionRecovery, markSessionRevalidated } from '../core/session-state.js';

export const OPERATOR_TELEGRAM_COMMAND_PATTERNS = {
  automationStatus: /\/automation_status/,
  pauseAutomation: /\/pause_automation(?:\s+(.+))?/,
  resumeAutomation: /\/resume_automation(?:\s+(.+))?/,
  requeueBlocked: /\/requeue_blocked(?:\s+(.+))?/,
  reconcileQueue: /\/reconcile_queue(?:\s+(.+))?/,
  ackSessionChallenge: /\/ack_session_challenge(?:\s+(.+))?/,
  ackSessionRecovery: /\/ack_session_recovery(?:\s+(.+))?/,
  markSessionRevalidated: /\/mark_session_revalidated(?:\s+(.+))?/
};

function getActorLabel(msg) {
  return `telegram:${msg.from?.username || 'unknown'}`;
}

export function registerOperatorTelegramCommands({
  bot,
  db,
  chatId,
  requireAuthorizedChat
}) {
  bot.onText(OPERATOR_TELEGRAM_COMMAND_PATTERNS.automationStatus, async (msg) => {
    if (!requireAuthorizedChat(msg.chat.id)) return;
    const status = getOperatorAutomationStatus(db);
    await bot.sendMessage(chatId, formatOperatorAutomationStatus(status));
  });

  bot.onText(OPERATOR_TELEGRAM_COMMAND_PATTERNS.pauseAutomation, async (msg, match) => {
    if (!requireAuthorizedChat(msg.chat.id)) return;
    const reason = (match?.[1] || '').trim() || 'telegram_pause';
    const result = pauseAutomation(db, { actor: getActorLabel(msg), reason });
    await bot.sendMessage(chatId, formatRecoverySummary('pause', result));
  });

  bot.onText(OPERATOR_TELEGRAM_COMMAND_PATTERNS.resumeAutomation, async (msg, match) => {
    if (!requireAuthorizedChat(msg.chat.id)) return;
    const reason = (match?.[1] || '').trim() || 'telegram_resume';
    const result = resumeAutomation(db, { actor: getActorLabel(msg), reason });
    await bot.sendMessage(chatId, formatRecoverySummary('resume', result));
  });

  bot.onText(OPERATOR_TELEGRAM_COMMAND_PATTERNS.requeueBlocked, async (msg, match) => {
    if (!requireAuthorizedChat(msg.chat.id)) return;
    const reason = (match?.[1] || '').trim() || 'telegram_requeue_blocked';
    const result = requeueBlockedJobs(db, { actor: getActorLabel(msg), reason });
    await bot.sendMessage(chatId, formatRecoverySummary('requeueBlocked', result));
  });

  bot.onText(OPERATOR_TELEGRAM_COMMAND_PATTERNS.reconcileQueue, async (msg, match) => {
    if (!requireAuthorizedChat(msg.chat.id)) return;
    const reason = (match?.[1] || '').trim() || 'telegram_reconcile_queue';
    const result = reconcileApprovedQueue(db, { actor: getActorLabel(msg), reason });
    await bot.sendMessage(chatId, formatRecoverySummary('reconcileQueue', result));
  });

  bot.onText(OPERATOR_TELEGRAM_COMMAND_PATTERNS.ackSessionChallenge, async (msg, match) => {
    if (!requireAuthorizedChat(msg.chat.id)) return;
    const reason = (match?.[1] || '').trim() || 'telegram_ack_session_challenge';
    acknowledgeSessionChallenge(db, { reason, metadata: { actor: getActorLabel(msg) } });
    await bot.sendMessage(chatId, 'Session challenge acknowledged. Trust is now pending revalidation.');
  });

  bot.onText(OPERATOR_TELEGRAM_COMMAND_PATTERNS.ackSessionRecovery, async (msg, match) => {
    if (!requireAuthorizedChat(msg.chat.id)) return;
    const reason = (match?.[1] || '').trim() || 'telegram_ack_session_recovery';
    acknowledgeSessionRecovery(db, { reason, metadata: { actor: getActorLabel(msg) } });
    await bot.sendMessage(chatId, 'Session recovery acknowledged. Quarantine remains until revalidation succeeds.');
  });

  bot.onText(OPERATOR_TELEGRAM_COMMAND_PATTERNS.markSessionRevalidated, async (msg, match) => {
    if (!requireAuthorizedChat(msg.chat.id)) return;
    const reason = (match?.[1] || '').trim() || 'telegram_mark_session_revalidated';
    markSessionRevalidated(db, { reason, metadata: { actor: getActorLabel(msg) } });
    await bot.sendMessage(chatId, 'Session marked revalidated. Trust restored and quarantine cleared.');
  });
}
