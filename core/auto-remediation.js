import { listActiveIncidents, transitionIncident } from './incidents.js';

function toSqliteDateTime(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 19).replace('T', ' ');
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function asDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function minutesSince(value, now = new Date()) {
  const date = asDate(value);
  if (!date) return null;
  return (now.getTime() - date.getTime()) / 60000;
}

function severityToLevel(severity) {
  if (severity === 'critical') return 'error';
  if (severity === 'warn') return 'warn';
  return 'info';
}

function insertRunEvent(db, incident, eventType, payload = {}) {
  db.prepare(`
    INSERT INTO run_events(job_id, level, event_type, payload_json)
    VALUES (NULL, ?, ?, ?)
  `).run(severityToLevel(incident?.severity), eventType, JSON.stringify({
    incidentKey: incident?.incidentKey,
    kind: incident?.kind,
    severity: incident?.severity,
    status: incident?.status,
    autoRecoveryAttempts: incident?.autoRecoveryAttempts,
    ...payload
  }));
}

function refreshAttemptMetadata(db, incidentKey, attemptCount, now) {
  db.prepare(`
    UPDATE active_incidents
    SET auto_recovery_attempts = ?,
        last_recovery_attempt_at = ?,
        updated_at = ?
    WHERE incident_key = ?
  `).run(attemptCount, now, now, incidentKey);

  return db.prepare(`SELECT * FROM active_incidents WHERE incident_key = ?`).get(incidentKey);
}

function mapIncidentRow(row) {
  if (!row) return null;
  return {
    incidentKey: row.incident_key,
    kind: row.kind,
    severity: row.severity,
    status: row.status,
    dedupeKey: row.dedupe_key,
    summary: row.summary,
    details: row.details_json ? JSON.parse(row.details_json) : null,
    sourceEventId: row.source_event_id,
    autoRecoveryAttempts: row.auto_recovery_attempts,
    lastRecoveryAttemptAt: row.last_recovery_attempt_at,
    startedAt: row.started_at,
    lastSeenAt: row.last_seen_at,
    resolvedAt: row.resolved_at,
    updatedAt: row.updated_at
  };
}

function actionNameForIncident(kind) {
  switch (kind) {
    case 'control_plane_stale':
      return 'restartControlPlane';
    case 'worker_stale':
      return 'restartWorker';
    case 'queue_stalled':
      return 'restartWorker';
    case 'telegram_delivery_degraded':
      return 'runSelfTests';
    default:
      return null;
  }
}

async function runAction(fn, incident, context, priorResults = []) {
  if (typeof fn !== 'function') {
    return { ok: false, skipped: true, reason: 'missing_action', incidentKind: incident.kind, priorResults };
  }
  const result = await fn({ incident, context, priorResults });
  if (result === false) return { ok: false, result };
  if (result && typeof result === 'object' && 'ok' in result) return result;
  return { ok: true, result };
}


function hasRecoveryActionForIncident(incident, actions = {}) {
  if (!incident) return false;
  if (incident.kind === 'queue_stalled') return typeof actions.restartWorker === 'function';
  if (incident.kind === 'telegram_delivery_degraded') return typeof actions.runSelfTests === 'function';
  const primary = actionNameForIncident(incident.kind);
  return !!primary && typeof actions[primary] === 'function';
}


export function buildRecoveryPolicy() {
  return {
    maxAttemptsPerIncident: 3,
    cooldownMinutes: 10,
    retryableKinds: ['control_plane_stale', 'worker_stale', 'telegram_delivery_degraded', 'queue_stalled'],
    nonRetryableKinds: ['account_challenge', 'account_logged_out']
  };
}

export function shouldAttemptRecovery(incident, policy, now = new Date()) {
  if (!incident || incident.status !== 'open') {
    return { ok: false, reason: 'not_open' };
  }
  if (policy.nonRetryableKinds.includes(incident.kind)) {
    return { ok: false, reason: 'non_retryable_kind' };
  }
  if (!policy.retryableKinds.includes(incident.kind)) {
    return { ok: false, reason: 'unsupported_kind' };
  }
  if ((incident.autoRecoveryAttempts || 0) >= policy.maxAttemptsPerIncident) {
    return { ok: false, reason: 'max_attempts_exhausted' };
  }
  const cooldownAgeMinutes = minutesSince(incident.lastRecoveryAttemptAt, now);
  if (cooldownAgeMinutes !== null && cooldownAgeMinutes < policy.cooldownMinutes) {
    return { ok: false, reason: 'cooldown_active', cooldownAgeMinutes };
  }
  return { ok: true, reason: 'eligible' };
}

export async function attemptIncidentRecovery(db, incident, context = {}) {
  const policy = context.policy || buildRecoveryPolicy();
  const nowDate = asDate(context.now) || new Date();
  const gate = shouldAttemptRecovery(incident, policy, nowDate);
  if (!gate.ok) return { ok: false, attempted: false, reason: gate.reason, incident };

  const actions = context.actions || {};
  if (!hasRecoveryActionForIncident(incident, actions)) {
    return { ok: false, attempted: false, reason: 'missing_action', incident };
  }

  const now = toSqliteDateTime(nowDate);
  const attemptCount = (incident.autoRecoveryAttempts || 0) + 1;
  const refreshedRow = refreshAttemptMetadata(db, incident.incidentKey, attemptCount, now);
  const refreshedIncident = mapIncidentRow(refreshedRow);
  const actionResults = [];
  const primaryActionName = actionNameForIncident(incident.kind);

  insertRunEvent(db, refreshedIncident, 'incident_recovery_attempted', {
    action: primaryActionName,
    attempt: attemptCount
  });

  let finalResult = { ok: false, reason: 'missing_action' };
  try {
    if (incident.kind === 'queue_stalled') {
      actionResults.push({ action: 'restartWorker', ...(await runAction(actions.restartWorker, refreshedIncident, context, actionResults)) });
      if (actionResults[actionResults.length - 1].ok) {
        const followUp = actions.reprobeQueue || actions.runSelfTests || actions.probeStatus;
        if (followUp) {
          actionResults.push({ action: followUp === actions.runSelfTests ? 'runSelfTests' : (followUp === actions.reprobeQueue ? 'reprobeQueue' : 'probeStatus'), ...(await runAction(followUp, refreshedIncident, context, actionResults)) });
        }
      }
      finalResult = actionResults.every((entry) => entry.ok) ? { ok: true } : actionResults.find((entry) => !entry.ok) || { ok: false };
    } else if (incident.kind === 'telegram_delivery_degraded') {
      actionResults.push({ action: 'runSelfTests', ...(await runAction(actions.runSelfTests, refreshedIncident, context, actionResults)) });
      finalResult = actionResults[0];
    } else if (incident.kind === 'control_plane_stale') {
      actionResults.push({ action: 'restartControlPlane', ...(await runAction(actions.restartControlPlane, refreshedIncident, context, actionResults)) });
      finalResult = actionResults[0];
    } else if (incident.kind === 'worker_stale') {
      actionResults.push({ action: 'restartWorker', ...(await runAction(actions.restartWorker, refreshedIncident, context, actionResults)) });
      finalResult = actionResults[0];
    }
  } catch (error) {
    finalResult = { ok: false, error: error?.message || String(error) };
  }

  const exhausted = attemptCount >= policy.maxAttemptsPerIncident && !finalResult.ok;
  if (finalResult.ok) {
    const transitioned = transitionIncident(db, {
      incidentKey: refreshedIncident.incidentKey,
      status: 'monitoring',
      summary: refreshedIncident.summary,
      severity: refreshedIncident.severity,
      details: {
        ...(refreshedIncident.details || {}),
        lastRecoveryResult: 'succeeded',
        actionResults
      },
      now
    });
    insertRunEvent(db, transitioned, 'incident_recovery_succeeded', {
      actionResults,
      attempt: attemptCount
    });
    return { ok: true, attempted: true, exhausted: false, incident: transitioned, actionResults };
  }

  const transitioned = transitionIncident(db, {
    incidentKey: refreshedIncident.incidentKey,
    status: refreshedIncident.status,
    summary: refreshedIncident.summary,
    severity: refreshedIncident.severity,
    details: {
      ...(refreshedIncident.details || {}),
      lastRecoveryResult: 'failed',
      actionResults,
      finalFailure: exhausted,
      error: finalResult.error || finalResult.reason || null
    },
    now
  });
  insertRunEvent(db, transitioned, 'incident_recovery_failed', {
    actionResults,
    attempt: attemptCount,
    exhausted,
    error: finalResult.error || finalResult.reason || null
  });
  return {
    ok: false,
    attempted: true,
    exhausted,
    incident: transitioned,
    actionResults,
    reason: finalResult.reason || finalResult.error || 'recovery_failed'
  };
}

export async function evaluateAutoRemediation(db, context = {}) {
  const policy = context.policy || buildRecoveryPolicy();
  const incidents = listActiveIncidents(db);
  const results = [];
  for (const incident of incidents) {
    const eligibility = shouldAttemptRecovery(incident, policy, context.now || new Date());
    if (!eligibility.ok) {
      results.push({ ok: false, attempted: false, reason: eligibility.reason, incident });
      continue;
    }
    results.push(await attemptIncidentRecovery(db, incident, { ...context, policy }));
  }
  return {
    ok: true,
    policy,
    evaluated: incidents.length,
    attempted: results.filter((result) => result.attempted).length,
    results
  };
}
