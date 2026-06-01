import { getReliabilityMetrics } from './metrics.js';
import { ratio } from './slo-policy.js';

function safeJsonParse(value) {
  try { return value ? JSON.parse(value) : {}; } catch { return {}; }
}

export function getSoakReport(db, options = {}) {
  const days = Math.max(1, Math.trunc(Number(options.days) || 7));
  const metrics = getReliabilityMetrics(db, { days });

  const incidentRows = db.prepare(`
    SELECT kind, severity, status, started_at, last_seen_at, resolved_at
    FROM active_incidents
    WHERE datetime(updated_at) >= datetime('now', ?)
       OR datetime(started_at) >= datetime('now', ?)
       OR (resolved_at IS NOT NULL AND datetime(resolved_at) >= datetime('now', ?))
  `).all(`-${days} days`, `-${days} days`, `-${days} days`);

  const remediationRows = db.prepare(`
    SELECT event_type, payload_json, created_at
    FROM run_events
    WHERE event_type IN ('incident_recovery_attempted', 'incident_recovery_succeeded', 'incident_recovery_failed')
      AND datetime(created_at) >= datetime('now', ?)
  `).all(`-${days} days`);

  const readinessRows = db.prepare(`
    SELECT event_type, payload_json, created_at
    FROM run_events
    WHERE event_type = 'worker_readiness_blocked'
      AND datetime(created_at) >= datetime('now', ?)
  `).all(`-${days} days`);

  const queuedAgeRow = db.prepare(`
    SELECT MAX((julianday('now') - julianday(created_at)) * 24 * 60) AS max_queued_age_minutes
    FROM like_jobs
    WHERE status = 'queued'
  `).get();

  const degradedWindowEvents = db.prepare(`
    SELECT event_type, payload_json, created_at
    FROM run_events
    WHERE event_type IN ('incident_opened', 'incident_resolved')
      AND datetime(created_at) >= datetime('now', ?)
    ORDER BY datetime(created_at) ASC, id ASC
  `).all(`-${days} days`);

  const healthEvents = db.prepare(`
    SELECT payload_json
    FROM run_events
    WHERE event_type = 'self_test_result'
      AND datetime(created_at) >= datetime('now', ?)
  `).all(`-${days} days`);

  const criticalIncidents = incidentRows.filter((row) => row.severity === 'critical').length;
  const operatorRequiredIncidents = incidentRows.filter((row) => row.kind === 'account_challenge' || row.kind === 'account_logged_out').length;
  const autoRecoveryAttempts = remediationRows.filter((row) => row.event_type === 'incident_recovery_attempted').length;
  const autoRecoveryFailures = remediationRows.filter((row) => row.event_type === 'incident_recovery_failed').length;
  const autoRecoverySuccesses = remediationRows.filter((row) => row.event_type === 'incident_recovery_succeeded').length;
  const readinessBlocks = readinessRows.length;
  const controlPlaneStaleIncidents = incidentRows.filter((row) => row.kind === 'control_plane_stale');
  const controlPlaneStaleMinutes = controlPlaneStaleIncidents.reduce((sum, row) => {
    const start = new Date(String(row.started_at).replace(' ', 'T') + 'Z').getTime();
    const endValue = row.resolved_at || row.last_seen_at || row.started_at;
    const end = new Date(String(endValue).replace(' ', 'T') + 'Z').getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return sum;
    return sum + ((end - start) / 60000);
  }, 0);

  const degradedMinutes = degradedWindowEvents.reduce((sum, row) => {
    const payload = safeJsonParse(row.payload_json);
    if (!payload || payload.severity !== 'critical' && payload.severity !== 'warn') return sum;
    return sum + 1;
  }, 0);

  const selfTestErrorCount = healthEvents.filter((row) => {
    const payload = safeJsonParse(row.payload_json);
    return payload.status === 'error' || payload.status === 'degraded';
  }).length;

  return {
    windowDays: days,
    summary: {
      successRate: metrics.summary.successRate,
      terminalCount: metrics.summary.terminalCount,
      criticalIncidents,
      operatorRequiredIncidents,
      autoRecoveryAttempts,
      autoRecoveryFailures,
      autoRecoverySuccesses,
      autoRecoverySuccessRate: ratio(autoRecoverySuccesses, autoRecoveryAttempts),
      readinessBlocks,
      maxQueuedAgeMinutes: queuedAgeRow?.max_queued_age_minutes ? Number(queuedAgeRow.max_queued_age_minutes.toFixed(2)) : 0,
      degradedMinutes,
      controlPlaneStaleMinutes: Number(controlPlaneStaleMinutes.toFixed(2)),
      selfTestErrorCount
    },
    incidents: incidentRows.map((row) => ({
      kind: row.kind,
      severity: row.severity,
      status: row.status,
      startedAt: row.started_at,
      lastSeenAt: row.last_seen_at,
      resolvedAt: row.resolved_at
    })),
    remediation: {
      attempts: autoRecoveryAttempts,
      failures: autoRecoveryFailures,
      successes: autoRecoverySuccesses
    },
    byDay: metrics.byDay,
    byPageShape: metrics.byPageShape,
    metrics
  };
}
