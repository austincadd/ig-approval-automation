import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { buildIncidentNotification, recordIncidentNotification, shouldNotifyIncidentTransition, wasIncidentNotificationSent } from '../core/escalation.js';

const schema = fs.readFileSync(path.resolve('db/schema.sql'), 'utf8');
const db = new Database(':memory:');
db.exec(schema);

const criticalIncident = {
  incidentKey: 'critical-1',
  kind: 'queue_stalled',
  severity: 'critical',
  status: 'open',
  summary: 'Queue stalled.',
  details: {}
};
const criticalTransition = shouldNotifyIncidentTransition(null, criticalIncident);
assert.equal(criticalTransition, 'opened_critical');
const criticalNotification = buildIncidentNotification(criticalIncident, { transitionType: criticalTransition });
recordIncidentNotification(db, {
  incidentKey: criticalIncident.incidentKey,
  transitionType: criticalTransition,
  payload: criticalNotification
});
assert.equal(wasIncidentNotificationSent(db, { incidentKey: criticalIncident.incidentKey, transitionType: criticalTransition }), true);

const refreshTransition = shouldNotifyIncidentTransition(criticalIncident, {
  ...criticalIncident,
  summary: 'Queue still stalled.'
});
assert.equal(refreshTransition, null);

const escalatedTransition = shouldNotifyIncidentTransition({
  incidentKey: 'worker-1',
  kind: 'worker_stale',
  severity: 'warn',
  status: 'open',
  summary: 'Worker stale.',
  details: {}
}, {
  incidentKey: 'worker-1',
  kind: 'worker_stale',
  severity: 'critical',
  status: 'open',
  summary: 'Worker stale and dead.',
  details: {}
});
assert.equal(escalatedTransition, 'escalated_critical');

const resolvedTransition = shouldNotifyIncidentTransition({
  ...criticalIncident,
  notified: true
}, {
  ...criticalIncident,
  status: 'resolved',
  summary: 'Recovered.'
});
assert.equal(resolvedTransition, 'resolved_notified_critical');
recordIncidentNotification(db, {
  incidentKey: criticalIncident.incidentKey,
  transitionType: resolvedTransition,
  payload: buildIncidentNotification({ ...criticalIncident, status: 'resolved' }, { transitionType: resolvedTransition })
});
assert.equal(wasIncidentNotificationSent(db, { incidentKey: criticalIncident.incidentKey, transitionType: resolvedTransition }), true);

const finalFailureTransition = shouldNotifyIncidentTransition({
  incidentKey: 'cp-1',
  kind: 'control_plane_stale',
  severity: 'warn',
  status: 'open',
  summary: 'Control plane stale.',
  details: { finalFailure: false }
}, {
  incidentKey: 'cp-1',
  kind: 'control_plane_stale',
  severity: 'warn',
  status: 'open',
  summary: 'Control plane still stale.',
  details: { finalFailure: true }
});
assert.equal(finalFailureTransition, 'recovery_failed_final');

const notificationText = buildIncidentNotification({
  ...criticalIncident,
  status: 'resolved'
}, {
  transitionType: 'resolved_notified_critical',
  actionResults: [{ action: 'restartWorker', ok: true }]
}).text;
assert.match(notificationText, /incident=queue_stalled/);
assert.match(notificationText, /recovery=restartWorker:ok/);

console.log('Escalation validation passed');
