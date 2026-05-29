import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { attemptIncidentRecovery, buildRecoveryPolicy, shouldAttemptRecovery } from '../core/auto-remediation.js';
import { openOrRefreshIncident } from '../core/incidents.js';

const schema = fs.readFileSync(path.resolve('db/schema.sql'), 'utf8');
const db = new Database(':memory:');
db.exec(schema);

const queueIncident = openOrRefreshIncident(db, {
  kind: 'queue_stalled',
  severity: 'warn',
  dedupeKey: 'queue_stalled',
  summary: 'Queue stalled.',
  now: '2026-05-29T10:00:00Z'
});

const actionsCalled = [];
const recoveryResult = await attemptIncidentRecovery(db, queueIncident, {
  now: '2026-05-29T10:05:00Z',
  actions: {
    restartWorker: async () => { actionsCalled.push('restartWorker'); return { ok: true }; },
    reprobeQueue: async () => { actionsCalled.push('reprobeQueue'); return { ok: true }; }
  }
});
assert.equal(recoveryResult.ok, true);
assert.equal(recoveryResult.attempted, true);
assert.deepEqual(actionsCalled, ['restartWorker', 'reprobeQueue']);
assert.equal(recoveryResult.incident.status, 'monitoring');
assert.equal(recoveryResult.incident.autoRecoveryAttempts, 1);
assert.equal(recoveryResult.incident.lastRecoveryAttemptAt, '2026-05-29 10:05:00');

const accountIncident = openOrRefreshIncident(db, {
  kind: 'account_challenge',
  severity: 'critical',
  dedupeKey: 'account_challenge',
  summary: 'Challenge detected.',
  now: '2026-05-29T10:10:00Z'
});
const policy = buildRecoveryPolicy();
assert.equal(shouldAttemptRecovery(accountIncident, policy, new Date('2026-05-29T10:10:00Z')).ok, false);
const accountAttempt = await attemptIncidentRecovery(db, accountIncident, {
  now: '2026-05-29T10:10:00Z',
  actions: {
    restartWorker: async () => ({ ok: true })
  }
});
assert.equal(accountAttempt.attempted, false);
assert.equal(accountAttempt.reason, 'non_retryable_kind');

const workerIncident = openOrRefreshIncident(db, {
  kind: 'worker_stale',
  severity: 'warn',
  dedupeKey: 'worker_stale',
  summary: 'Worker stale.',
  now: '2026-05-29T10:20:00Z'
});
const maxedOut = await attemptIncidentRecovery(db, workerIncident, {
  now: '2026-05-29T10:21:00Z',
  policy: { ...policy, maxAttemptsPerIncident: 0 },
  actions: {
    restartWorker: async () => ({ ok: true })
  }
});
assert.equal(maxedOut.attempted, false);
assert.equal(maxedOut.reason, 'max_attempts_exhausted');

const cooldownIncident = openOrRefreshIncident(db, {
  kind: 'control_plane_stale',
  severity: 'warn',
  dedupeKey: 'control_plane_stale',
  summary: 'Control plane stale.',
  now: '2026-05-29T10:30:00Z'
});
await attemptIncidentRecovery(db, cooldownIncident, {
  now: '2026-05-29T10:31:00Z',
  actions: {
    restartControlPlane: async () => ({ ok: false, reason: 'first_fail' })
  }
});
const cooldownRow = db.prepare(`SELECT * FROM active_incidents WHERE incident_key = ?`).get(cooldownIncident.incidentKey);
assert.equal(cooldownRow.auto_recovery_attempts, 1);
const cooldownGate = shouldAttemptRecovery({
  incidentKey: cooldownRow.incident_key,
  kind: cooldownRow.kind,
  severity: cooldownRow.severity,
  status: cooldownRow.status,
  autoRecoveryAttempts: cooldownRow.auto_recovery_attempts,
  lastRecoveryAttemptAt: cooldownRow.last_recovery_attempt_at
}, policy, new Date('2026-05-29T10:35:00Z'));
assert.equal(cooldownGate.ok, false);
assert.equal(cooldownGate.reason, 'cooldown_active');

const remediationEvents = db.prepare(`
  SELECT event_type
  FROM run_events
  WHERE event_type LIKE 'incident_recovery_%'
  ORDER BY id ASC
`).all().map((row) => row.event_type);
assert.deepEqual(remediationEvents, [
  'incident_recovery_attempted',
  'incident_recovery_succeeded',
  'incident_recovery_attempted',
  'incident_recovery_failed'
]);

console.log('Auto-remediation validation passed');
