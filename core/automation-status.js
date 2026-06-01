import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getAutomationStatus } from './recovery.js';
import { readExecutorCanaryResult } from './canary.js';
import { readAccountSessionState } from './session-state.js';
import { getReliabilityMetrics } from './metrics.js';
import { getPolicyVersions } from './policy-versions.js';
import { readSelfTestResults, summarizeSelfTests } from './self-tests.js';
import { getIncidentSummary, listActiveIncidents, openOrRefreshIncident, resolveIncident } from './incidents.js';
import { detectQueueStall } from './stall-detection.js';
import { evaluateReadiness, formatReadiness } from './readiness.js';
import { getSoakReport } from './soak-report.js';
import { evaluateSlo } from './slo-policy.js';
import { evaluateExecutorOwner } from './executor-ownership.js';

function toPositiveInteger(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function isProcessAlive(pid) {
  const parsedPid = toPositiveInteger(pid);
  if (!parsedPid) return false;
  try {
    process.kill(parsedPid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function readJsonFileSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function formatProcessHealth({ configured, alive, stale = false }) {
  if (!configured) return 'not_configured';
  if (alive) return 'running';
  if (stale) return 'stale';
  return 'not_running';
}

function readFlagJson(db, key) {
  try {
    const raw = db.prepare('SELECT value FROM system_flags WHERE key=?').get(key)?.value;
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function readBotProcessStatus(lockPath) {
  const resolvedLockPath = path.resolve(lockPath || 'data/telegram-bot.lock');
  const exists = fs.existsSync(resolvedLockPath);
  const metadata = exists ? readJsonFileSafe(resolvedLockPath) : null;
  const pid = toPositiveInteger(metadata?.pid);
  const alive = isProcessAlive(pid);
  const stale = exists && !!pid && !alive;

  return {
    configured: true,
    lockPath: resolvedLockPath,
    lockExists: exists,
    pid,
    startedAt: metadata?.startedAt || null,
    label: metadata?.label || null,
    bindHost: metadata?.bindHost || null,
    cwd: metadata?.cwd || null,
    alive,
    stale,
    health: formatProcessHealth({ configured: true, alive, stale })
  };
}

function readLaunchctlService(label) {
  const launchdLabel = String(label || '').trim();
  if (!launchdLabel) {
    return {
      configured: false,
      label: null,
      health: 'not_configured',
      loaded: false,
      alive: false,
      pid: null,
      lastExitCode: null,
      rawState: null,
      detail: 'No launchd worker label configured.'
    };
  }

  const domain = typeof process.getuid === 'function'
    ? `gui/${process.getuid()}/${launchdLabel}`
    : launchdLabel;
  const result = spawnSync('launchctl', ['print', domain], { encoding: 'utf8', timeout: 5000 });

  if (result.error) {
    return {
      configured: true,
      label: launchdLabel,
      health: 'unknown',
      loaded: false,
      alive: false,
      pid: null,
      lastExitCode: null,
      rawState: null,
      detail: `launchctl unavailable: ${result.error.message}`
    };
  }

  if (result.status !== 0) {
    return {
      configured: true,
      label: launchdLabel,
      health: 'not_running',
      loaded: false,
      alive: false,
      pid: null,
      lastExitCode: null,
      rawState: null,
      detail: (result.stderr || result.stdout || 'launchctl print failed').trim()
    };
  }

  const text = `${result.stdout || ''}\n${result.stderr || ''}`;
  const pid = toPositiveInteger(text.match(/\bpid = (\d+)/)?.[1]);
  const alive = isProcessAlive(pid);
  const rawState = text.match(/\bstate = ([^\n]+)/)?.[1]?.trim() || null;
  const lastExitCode = (() => {
    const match = text.match(/\blast exit code = (-?\d+)/i);
    if (!match) return null;
    const value = Number(match[1]);
    return Number.isFinite(value) ? value : null;
  })();

  return {
    configured: true,
    label: launchdLabel,
    health: alive ? 'running' : 'loaded_idle',
    loaded: true,
    alive,
    pid,
    lastExitCode,
    rawState,
    detail: null
  };
}

function readRecentTerminalFailures(db, limit = 5) {
  return db.prepare(`
    SELECT re.id,
           re.job_id,
           re.event_type,
           re.created_at,
           lj.candidate_id,
           c.post_url,
           lj.error_code,
           lj.error_message,
           lj.failure_class,
           lj.failure_policy,
           lj.evidence_bundle_path
    FROM run_events re
    LEFT JOIN like_jobs lj ON lj.id = re.job_id
    LEFT JOIN candidates c ON c.id = lj.candidate_id
    WHERE re.event_type IN ('job_failed', 'job_blocked')
    ORDER BY re.id DESC
    LIMIT ?
  `).all(limit).map((row) => ({
    eventId: row.id,
    jobId: row.job_id,
    candidateId: row.candidate_id,
    eventType: row.event_type,
    createdAt: row.created_at,
    postUrl: row.post_url,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    failureClass: row.failure_class,
    failurePolicy: row.failure_policy,
    evidenceBundlePath: row.evidence_bundle_path || null
  }));
}

function readWorkerRunSummary(db) {
  const row = db.prepare(`
    SELECT
      MAX(started_at) AS last_started_at,
      MAX(finished_at) AS last_finished_at,
      MAX(CASE WHEN status = 'success' THEN finished_at END) AS last_success_at,
      MAX(CASE WHEN status IN ('failed', 'blocked') THEN finished_at END) AS last_terminal_failure_at,
      MAX(CASE WHEN status = 'running' THEN updated_at END) AS last_running_update_at
    FROM like_jobs
  `).get();

  const recentRunning = db.prepare(`
    SELECT id, candidate_id, started_at, updated_at
    FROM like_jobs
    WHERE status = 'running'
    ORDER BY datetime(COALESCE(updated_at, started_at, created_at)) DESC, id DESC
    LIMIT 1
  `).get();

  return {
    lastStartedAt: row?.last_started_at || null,
    lastFinishedAt: row?.last_finished_at || null,
    lastSuccessAt: row?.last_success_at || null,
    lastTerminalFailureAt: row?.last_terminal_failure_at || null,
    lastRunningUpdateAt: row?.last_running_update_at || null,
    activeJob: recentRunning ? {
      jobId: recentRunning.id,
      candidateId: recentRunning.candidate_id,
      startedAt: recentRunning.started_at,
      updatedAt: recentRunning.updated_at
    } : null
  };
}

function readWorkerLogTail(logPath, maxLines = 40) {
  const resolved = path.resolve(logPath);
  try {
    const text = fs.readFileSync(resolved, 'utf8');
    const lines = text.split(/\r?\n/).filter(Boolean);
    return {
      path: resolved,
      exists: true,
      lines: lines.slice(-Math.max(1, maxLines))
    };
  } catch {
    return {
      path: resolved,
      exists: false,
      lines: []
    };
  }
}

function readWorkerLogSignal(logPath) {
  const tail = readWorkerLogTail(logPath);
  const lastLine = tail.lines.length ? tail.lines[tail.lines.length - 1] : null;
  return {
    path: tail.path,
    exists: tail.exists,
    lastLine
  };
}

function deriveExecutorHealth(base, worker, canary) {
  if (!base.automationEnabled) return 'paused';
  if (canary?.ok === false) return 'degraded';
  if (worker.activeJob) return 'busy';
  if (!worker.alive && base.counts.queued > 0) return 'stale';
  if (base.counts.queued > 0) return 'ready';
  return 'idle';
}

function deriveAccountHealth(canary, sessionState) {
  if (sessionState?.sessionHealth === 'challenge') return 'challenge';
  if (sessionState?.sessionHealth === 'logged_out') return 'logged_out';
  if (sessionState?.quarantineState && sessionState.quarantineState !== 'clear') return 'quarantined';
  if (!canary) return sessionState?.sessionHealth || 'unknown';
  if (canary.code === 'CANARY_NOT_LOGGED_IN') return 'logged_out';
  if (canary.code === 'CANARY_CHALLENGE_DETECTED') return 'challenge';
  return canary.ok ? 'ok' : ((sessionState?.sessionHealth && sessionState.sessionHealth !== 'unknown' && sessionState.sessionHealth !== 'ok') ? sessionState.sessionHealth : 'degraded');
}

function deriveDeliveryHealth(telegramHealth, bot) {
  if (telegramHealth?.duplicatePollerDetected) return 'fatal';
  if (bot.stale) return 'stale';
  if (telegramHealth?.status) return telegramHealth.status;
  return bot.alive ? 'ok' : 'degraded';
}

function deriveControlPlaneHealth(bot) {
  if (bot.stale) return 'stale';
  if (!bot.alive) return 'degraded';
  return 'ok';
}

function deriveSystemState({ base, canary, worker, deliveryHealth, accountHealth, controlPlaneHealth, selfTestSummary }) {
  if (!base.automationEnabled) return 'paused';
  if (deliveryHealth === 'fatal') return 'unsafe';
  if (accountHealth === 'challenge' || accountHealth === 'logged_out') return 'operator_required';
  if (canary?.ok === false) return canary.state || 'degraded';
  if (!worker.alive && base.counts.queued > 0) return 'unsafe';
  if (selfTestSummary?.overall === 'error') return 'degraded';
  if (controlPlaneHealth !== 'ok') return 'degraded';
  if (deliveryHealth === 'degraded') return 'degraded';
  if (selfTestSummary?.overall === 'degraded') return 'degraded';
  if (base.counts.running === 0 && base.counts.queued === 0) return 'idle';
  return 'healthy';
}


function buildDerivedIncidents({ base, bot, worker, telegramHealth, accountHealth, controlPlaneHealth, deliveryHealth, stallDetection }) {
  const incidents = [];

  if (stallDetection?.stalled && stallDetection.incident) {
    incidents.push({
      ...stallDetection.incident,
      clearSummary: 'Queue stall cleared.'
    });
  }

  if (base.automationEnabled && (!bot.alive || bot.stale)) {
    incidents.push({
      kind: 'control_plane_stale',
      severity: bot.stale ? 'critical' : 'warn',
      dedupeKey: 'control_plane_stale',
      summary: bot.stale ? 'Control plane lock is stale.' : 'Control plane is not running.',
      details: {
        health: controlPlaneHealth,
        alive: bot.alive,
        stale: bot.stale,
        pid: bot.pid,
        lockPath: bot.lockPath,
        bindHost: bot.bindHost
      },
      clearSummary: 'Control plane incident cleared.'
    });
  }

  if (base.automationEnabled && worker.configured && !worker.alive) {
    incidents.push({
      kind: 'worker_stale',
      severity: base.counts.queued > 0 ? 'critical' : 'warn',
      dedupeKey: 'worker_stale',
      summary: base.counts.queued > 0
        ? 'Worker is not alive while queued work is waiting.'
        : 'Worker is not alive while automation is enabled.',
      details: {
        health: worker.health,
        label: worker.label,
        detail: worker.detail,
        queueDepth: base.counts.queued,
        lastSuccessAt: worker.lastSuccessAt,
        lastRunningUpdateAt: worker.lastRunningUpdateAt,
        lastExitCode: worker.lastExitCode
      },
      clearSummary: 'Worker incident cleared.'
    });
  }

  if (deliveryHealth !== 'ok') {
    incidents.push({
      kind: 'telegram_delivery_degraded',
      severity: deliveryHealth === 'fatal' || deliveryHealth === 'stale' ? 'critical' : 'warn',
      dedupeKey: 'telegram_delivery_degraded',
      summary: telegramHealth?.lastError
        ? `Telegram transport degraded: ${telegramHealth.lastError}`
        : 'Telegram transport degraded.',
      details: {
        health: deliveryHealth,
        transport: telegramHealth,
        botAlive: bot.alive,
        botStale: bot.stale
      },
      clearSummary: 'Telegram delivery recovered.'
    });
  }

  if (accountHealth === 'challenge') {
    incidents.push({
      kind: 'account_challenge',
      severity: 'critical',
      dedupeKey: 'account_challenge',
      summary: 'Instagram account challenge detected.',
      details: { accountHealth },
      clearSummary: 'Instagram account challenge cleared.'
    });
  }

  if (accountHealth === 'logged_out') {
    incidents.push({
      kind: 'account_logged_out',
      severity: 'critical',
      dedupeKey: 'account_logged_out',
      summary: 'Instagram account is logged out.',
      details: { accountHealth },
      clearSummary: 'Instagram account login restored.'
    });
  }

  return incidents;
}

function syncDerivedIncidents(db, incidents, now) {
  const activeKeys = new Set();
  for (const incident of incidents) {
    activeKeys.add(incident.dedupeKey);
    openOrRefreshIncident(db, {
      kind: incident.kind,
      severity: incident.severity,
      dedupeKey: incident.dedupeKey,
      summary: incident.summary,
      details: incident.details,
      now
    });
  }

  for (const dedupeKey of [
    'queue_stalled',
    'control_plane_stale',
    'worker_stale',
    'telegram_delivery_degraded',
    'account_challenge',
    'account_logged_out'
  ]) {
    if (activeKeys.has(dedupeKey)) continue;
    const managedIncident = incidents.find((incident) => incident.dedupeKey == dedupeKey);
    resolveIncident(db, {
      dedupeKey,
      summary: managedIncident?.clearSummary || `${dedupeKey} cleared.`,
      details: { cleared: true },
      now
    });
  }
}


export function getOperatorAutomationStatus(db, options = {}) {
  const base = getAutomationStatus(db);
  const bot = readBotProcessStatus(options.telegramBotLockPath || process.env.TELEGRAM_BOT_LOCK_PATH || 'data/telegram-bot.lock');
  const workerService = readLaunchctlService(options.workerLaunchdLabel || process.env.WORKER_LAUNCHD_LABEL || 'com.austincaddell.ig-approval-worker');
  const workerRuns = readWorkerRunSummary(db);
  const recentTerminalFailures = readRecentTerminalFailures(db, options.failureLimit || 5);
  const stdoutLog = readWorkerLogSignal(options.workerStdoutLogPath || 'logs/worker.launchd.out.log');
  const stderrLog = readWorkerLogSignal(options.workerStderrLogPath || 'logs/worker.launchd.err.log');
  const canary = readExecutorCanaryResult(db);
  const sessionState = readAccountSessionState(db);
  const metrics = getReliabilityMetrics(db, { days: options.metricsWindowDays || 7 });
  const policyVersions = getPolicyVersions();
  const selfTests = readSelfTestResults(db);
  const selfTestSummary = summarizeSelfTests(selfTests);
  const telegramHealth = readFlagJson(db, 'TELEGRAM_TRANSPORT_HEALTH') || {
    status: bot.alive ? 'ok' : 'degraded',
    restartAttempts: 0,
    duplicatePollerDetected: false,
    sendFailures: 0,
    pollingErrors: 0,
    lastError: null,
    updatedAt: null
  };

  const worker = {
    ...workerService,
    ...workerRuns,
    stdoutLog,
    stderrLog
  };

  const accountHealth = deriveAccountHealth(canary, sessionState);
  const deliveryHealth = deriveDeliveryHealth(telegramHealth, bot);
  const controlPlaneHealth = deriveControlPlaneHealth(bot);
  const health = {
    state: deriveSystemState({ base, canary, worker, deliveryHealth, accountHealth, controlPlaneHealth, selfTestSummary }),
    controlPlane: controlPlaneHealth,
    executor: deriveExecutorHealth(base, worker, canary),
    delivery: deliveryHealth,
    account: accountHealth,
    queue: base.counts.queued > 0 ? 'backlog_present' : 'empty',
    canary
  };

  const stallDetection = detectQueueStall({
    ...base,
    bot,
    worker,
    telegramTransport: telegramHealth,
    sessionState,
    health
  }, {
    now: options.now,
    queueStallMinutes: options.queueStallMinutes,
    workerStaleMinutes: options.workerStaleMinutes,
    progressStaleMinutes: options.progressStaleMinutes
  });

  const derivedIncidents = buildDerivedIncidents({
    base,
    bot,
    worker,
    telegramHealth,
    accountHealth,
    controlPlaneHealth,
    deliveryHealth,
    stallDetection
  });
  syncDerivedIncidents(db, derivedIncidents, options.now);

  const activeIncidents = listActiveIncidents(db);
  const incidentSummary = getIncidentSummary(db);
  const statusSnapshot = {
    ...base,
    bot,
    worker,
    telegramTransport: telegramHealth,
    sessionState,
    metrics,
    policyVersions,
    selfTests: {
      summary: selfTestSummary,
      results: selfTests
    },
    health,
    recentTerminalFailures,
    incidents: {
      summary: incidentSummary,
      active: activeIncidents
    }
  };
  const readiness = evaluateReadiness(db, statusSnapshot, options);
  const executorOwner = evaluateExecutorOwner(db, { ownerKey: 'browser-profile' });
  const soak = getSoakReport(db, { days: options.soakWindowDays || 7 });
  const slo = evaluateSlo({ ...statusSnapshot, readiness }, soak, options);

  return {
    ...base,
    bot,
    worker,
    telegramTransport: telegramHealth,
    sessionState,
    metrics,
    policyVersions,
    selfTests: {
      summary: selfTestSummary,
      results: selfTests
    },
    health,
    recentTerminalFailures,
    incidents: {
      summary: incidentSummary,
      active: activeIncidents
    },
    readiness,
    executorOwner,
    soak,
    slo
  };
}

export function formatOperatorAutomationStatus(status) {
  const workerProcessLine = `Worker: ${status.worker.health}${status.worker.pid ? ` (pid ${status.worker.pid})` : ''}`;
  const botProcessLine = `Bot: ${status.bot.health}${status.bot.pid ? ` (pid ${status.bot.pid})` : ''}`;
  const queueLine = `Queue: queued=${status.counts.queued} running=${status.counts.running} blocked=${status.counts.blocked} failed=${status.counts.failed} success=${status.counts.success} stopped=${status.counts.stopped}`;
  const driftLine = `Approved missing active/success job: ${status.approvedWithoutActive}`;
  const workerRunLine = `Worker last run: ${status.worker.lastFinishedAt || status.worker.lastStartedAt || 'never'}`;
  const lastFailureLine = `Recent terminal failures: ${status.recentTerminalFailures.length}`;
  const blockerLine = `Current blockers: ${status.activeBlockerCount} | Historical blocked: ${status.historicalBlockedCount}`;
  const incidentLine = `Incidents: active=${status.incidents?.summary?.totalActive ?? 0} critical=${status.incidents?.summary?.bySeverity?.critical ?? 0} warn=${status.incidents?.summary?.bySeverity?.warn ?? 0}`;
  const readinessLine = status.readiness ? formatReadiness(status.readiness) : null;
  const executorLine = status.executorOwner ? `Executor owner: ${status.executorOwner.state} | mode=${status.executorOwner.owner?.mode || 'none'} pid=${status.executorOwner.owner?.pid || 'n/a'}` : null;
  const sloLine = status.slo ? `SLO: ${status.slo.state} | violations=${status.slo.violations.length}` : null;
  const soakLine = status.soak ? `Soak(${status.soak.windowDays}d): recoverySuccess=${status.soak.summary.autoRecoverySuccessRate ?? 'n/a'} readinessBlocks=${status.soak.summary.readinessBlocks ?? 0} maxQueueAgeMin=${status.soak.summary.maxQueuedAgeMinutes ?? 0}` : null;

  const failureLines = status.recentTerminalFailures.slice(0, 3).map((row) => {
    const code = row.errorCode || 'UNKNOWN';
    const failureClass = row.failureClass || 'unclassified';
    return `- ${row.eventType} job ${row.jobId ?? '?'} candidate ${row.candidateId ?? '?'} ${code} [${failureClass}] @ ${row.createdAt}`;
  });

  return [
    `Automation: ${status.automationEnabled ? 'enabled' : 'paused'}`,
    `Health: ${status.health.state} | control=${status.health.controlPlane} executor=${status.health.executor} delivery=${status.health.delivery} account=${status.health.account}`,
    status.health.canary ? `Canary: ${status.health.canary.ok ? 'ok' : status.health.canary.code}` : 'Canary: never run',
    botProcessLine,
    workerProcessLine,
    workerRunLine,
    queueLine,
    incidentLine,
    readinessLine,
    executorLine,
    sloLine,
    soakLine,
    blockerLine,
    `Pending approvals: ${status.pendingApprovals}`,
    driftLine,
    `Recovery-suppressed candidates: ${status.recoverySuppressedCount || 0}`,
    `Session: health=${status.sessionState.sessionHealth} quarantine=${status.sessionState.quarantineState}`,
    status.sessionState.lastLoginConfirmedAt ? `Last login confirmed: ${status.sessionState.lastLoginConfirmedAt}` : null,
    status.sessionState.lastChallengeAt ? `Last challenge: ${status.sessionState.lastChallengeAt}` : null,
    status.sessionState.lastSuccessfulActionAt ? `Last successful action: ${status.sessionState.lastSuccessfulActionAt}` : null,
    status.metrics?.summary ? `SLO(7d metrics): success=${status.metrics.summary.successRate ?? 'n/a'} selectorFail=${status.metrics.summary.selectorFailureRate ?? 'n/a'} verificationFail=${status.metrics.summary.verificationFailureRate ?? 'n/a'} challenge=${status.metrics.summary.challengeIncidenceRate ?? 'n/a'} deliveryDegraded=${status.metrics.summary.telegramDeliveryDegradationRate ?? 'n/a'} mttoiMin=${status.metrics.summary.meanTimeToOperatorInterventionMinutes ?? 'n/a'}` : null,
    status.selfTests?.summary ? `Self-tests: overall=${status.selfTests.summary.overall} total=${status.selfTests.summary.total} ok=${status.selfTests.summary.counts?.ok ?? 0} degraded=${status.selfTests.summary.counts?.degraded ?? 0} error=${status.selfTests.summary.counts?.error ?? 0} skipped=${status.selfTests.summary.counts?.skipped ?? 0}` : null,
    status.policyVersions ? `Policy versions: schema=${status.policyVersions.schemaVersion} selectors=${status.policyVersions.selectorStrategyVersion} failure=${status.policyVersions.failurePolicyVersion} retry=${status.policyVersions.retryPolicyVersion} suppression=${status.policyVersions.suppressionPolicyVersion} canary=${status.policyVersions.canaryPolicyVersion}` : null,
    lastFailureLine,
    failureLines.length ? 'Failure detail:\n' + failureLines.join('\n') : null,
    status.worker.detail ? `Worker detail: ${status.worker.detail}` : null,
    status.bot.stale ? 'Bot lock is stale; restart the bot if this is unexpected.' : null
  ].filter(Boolean).join('\n');
}
