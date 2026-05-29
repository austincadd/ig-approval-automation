import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getIncidentSummary, listActiveIncidents, openOrRefreshIncident, resolveIncident, suppressIncident } from '../core/incidents.js';

const schema = fs.readFileSync(path.resolve('db/schema.sql'), 'utf8');
const db = new Database(':memory:');
db.exec(schema);

const opened = openOrRefreshIncident(db, {
  kind: 'queue_stalled',
  severity: 'warn',
  dedupeKey: 'queue_stalled',
  summary: 'Queue has stopped making progress.',
  details: { queued: 3 },
  now: '2026-05-29T10:00:00Z'
});
assert.equal(opened.kind, 'queue_stalled');
assert.equal(opened.status, 'open');
assert.equal(opened.autoRecoveryAttempts, 0);
assert.equal(listActiveIncidents(db).length, 1);

const refreshed = openOrRefreshIncident(db, {
  kind: 'queue_stalled',
  severity: 'critical',
  dedupeKey: 'queue_stalled',
  summary: 'Queue is still stalled and worker is down.',
  details: { queued: 4, workerAlive: false },
  now: '2026-05-29T10:05:00Z'
});
assert.equal(refreshed.incidentKey, opened.incidentKey);
assert.equal(refreshed.severity, 'critical');
assert.equal(refreshed.summary, 'Queue is still stalled and worker is down.');
assert.equal(refreshed.lastSeenAt, '2026-05-29 10:05:00');
assert.equal(listActiveIncidents(db).length, 1);

const second = openOrRefreshIncident(db, {
  kind: 'telegram_delivery_degraded',
  severity: 'info',
  dedupeKey: 'telegram_delivery_degraded',
  summary: 'Telegram delivery has intermittent failures.',
  details: { sendFailures: 1 },
  now: '2026-05-29T10:06:00Z'
});
assert.notEqual(second.incidentKey, opened.incidentKey);

const resolved = resolveIncident(db, {
  incidentKey: opened.incidentKey,
  summary: 'Queue recovered.',
  details: { recovered: true },
  now: '2026-05-29T10:10:00Z'
});
assert.equal(resolved.status, 'resolved');
assert.equal(resolved.resolvedAt, '2026-05-29 10:10:00');
assert.equal(listActiveIncidents(db).length, 1);

const suppressed = suppressIncident(db, {
  incidentKey: second.incidentKey,
  summary: 'Noise suppressed.',
  details: { reason: 'operator_ack' },
  now: '2026-05-29T10:12:00Z'
});
assert.equal(suppressed.status, 'suppressed');
assert.equal(listActiveIncidents(db).length, 0);

const summary = getIncidentSummary(db);
assert.equal(summary.totalActive, 0);
assert.equal(summary.bySeverity.info, 0);
assert.equal(summary.bySeverity.warn, 0);
assert.equal(summary.bySeverity.critical, 0);
assert.equal(summary.hasCritical, false);
assert.equal(summary.requiresOperator, false);

const events = db.prepare(`SELECT event_type FROM run_events ORDER BY id ASC`).all().map((row) => row.event_type);
assert.deepEqual(events, [
  'incident_opened',
  'incident_updated',
  'incident_notification_recorded',
  'incident_opened',
  'incident_resolved',
  'incident_notification_recorded',
  'incident_suppressed'
]);

const priorSummary = openOrRefreshIncident(db, {
  kind: 'account_challenge',
  severity: 'critical',
  dedupeKey: 'account_challenge',
  summary: 'Instagram challenge detected.',
  now: '2026-05-29T10:20:00Z'
});
assert.equal(priorSummary.kind, 'account_challenge');
const activeSummary = getIncidentSummary(db);
assert.equal(activeSummary.totalActive, 1);
assert.equal(activeSummary.bySeverity.critical, 1);
assert.equal(activeSummary.byKind.account_challenge, 1);
assert.equal(activeSummary.hasCritical, true);
assert.equal(activeSummary.requiresOperator, true);

const notifications = db.prepare(`SELECT incident_key, transition_type FROM incident_notifications ORDER BY id ASC`).all();
assert.deepEqual(notifications, [
  { incident_key: opened.incidentKey, transition_type: 'escalated_critical' },
  { incident_key: opened.incidentKey, transition_type: 'resolved_notified_critical' },
  { incident_key: priorSummary.incidentKey, transition_type: 'opened_critical' }
]);
const postNotificationEvents = db.prepare(`SELECT event_type FROM run_events WHERE event_type = 'incident_notification_recorded'`).all();
assert.equal(postNotificationEvents.length, 3);

console.log('Incident validation passed');
