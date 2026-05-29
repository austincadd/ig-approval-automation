import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { registerOperatorHttpRoutes } from '../bot/operator-http-routes.js';

const schema = fs.readFileSync(path.resolve('db/schema.sql'), 'utf8');
const db = new Database(':memory:');
db.exec(schema);

db.prepare(`INSERT INTO candidates(post_url, source) VALUES ('https://instagram.com/p/a', 'test')`).run();
db.prepare(`INSERT INTO approvals(candidate_id, decision, decided_by) VALUES (1, 'approved', 'test')`).run();
db.prepare(`INSERT INTO like_jobs(candidate_id, status, error_code, error_message, failure_class, failure_policy, evidence_bundle_path, updated_at)
  VALUES (1, 'blocked', 'CHECKPOINT_DETECTED', 'challenge', 'account_challenge', 'require_operator_action', 'artifacts/failures/job-1', datetime('now'))`).run();
db.prepare(`INSERT INTO self_test_results(test_key, status, summary, details_json, checked_at, updated_at)
  VALUES ('db_integrity', 'ok', 'queue sane', '{}', datetime('now'), datetime('now'))`).run();
db.prepare(`INSERT INTO system_flags(key, value, updated_at) VALUES ('TELEGRAM_TRANSPORT_HEALTH', ?, datetime('now'))`).run(JSON.stringify({ status: 'degraded', duplicatePollerDetected: false, sendFailures: 1, pollingErrors: 1, lastError: 'timeout' }));
db.prepare(`INSERT INTO active_incidents(incident_key, kind, severity, status, dedupe_key, summary, started_at, last_seen_at, updated_at)
  VALUES ('incident-1', 'telegram_delivery_degraded', 'warn', 'open', 'telegram_delivery_degraded', 'Telegram transport degraded.', datetime('now'), datetime('now'), datetime('now'))`).run();

const routes = [];
const app = {
  get(route, handler) { routes.push({ method: 'GET', route, handler }); },
  post(route, handler) { routes.push({ method: 'POST', route, handler }); }
};

let remediationCalls = 0;
registerOperatorHttpRoutes({
  app,
  db,
  isAuthorizedControlRequest: () => true,
  rejectUnauthorizedControlRequest: (_req, res) => res.status(403).json({ ok: false }),
  sendReviewBatch: async () => ({ sent: 0 }),
  remediationContext: {
    actions: {
      runSelfTests: async () => { remediationCalls += 1; return { ok: true }; }
    }
  }
});

const dashboardRoute = routes.find((entry) => entry.method === 'GET' && entry.route === '/automation/dashboard');
assert.ok(dashboardRoute, 'expected /automation/dashboard route');
let dashboardHtml = '';
dashboardRoute.handler({}, {
  type(value) { assert.equal(value, 'html'); return this; },
  send(value) { dashboardHtml = value; }
});
assert.match(dashboardHtml, /IG Automation Operator Dashboard/);
assert.match(dashboardHtml, /Pause automation/);
assert.match(dashboardHtml, /Recent failures/);
assert.match(dashboardHtml, /Active incidents/);
assert.match(dashboardHtml, /Telegram transport degraded: timeout/);
assert.match(dashboardHtml, /Self-tests/);
assert.match(dashboardHtml, /Policy versions/);

const actionRoute = routes.find((entry) => entry.method === 'POST' && entry.route === '/automation/action');
assert.ok(actionRoute, 'expected /automation/action route');
const incidentsRoute = routes.find((entry) => entry.method === 'GET' && entry.route === '/automation/incidents');
assert.ok(incidentsRoute, 'expected /automation/incidents route');
let incidentsPayload = null;
incidentsRoute.handler({ get: () => 'application/json' }, {
  json(value) { incidentsPayload = value; },
  status(code) { this.statusCode = code; return this; }
});
assert.equal(incidentsPayload.ok, true);
assert.equal(incidentsPayload.summary.totalActive, 1);
assert.equal(incidentsPayload.incidents[0].kind, 'telegram_delivery_degraded');

let actionResponse = null;
actionRoute.handler({ body: { action: 'pause', reason: 'dashboard test' }, get: () => 'application/json' }, {
  json(value) { actionResponse = value; },
  status(code) { this.statusCode = code; return this; }
});
assert.equal(actionResponse.ok, true);
assert.equal(actionResponse.result.automationEnabled, false);
assert.equal(actionResponse.status.automationEnabled, false);

let suppressResponse = null;
actionRoute.handler({ body: { action: 'suppress_candidate', candidateId: '1', reason: 'dashboard suppress' }, get: () => 'application/json' }, {
  json(value) { suppressResponse = value; },
  status(code) { this.statusCode = code; return this; }
});
assert.equal(suppressResponse.ok, true);
assert.equal(suppressResponse.result.candidateId, 1);

let redirectedTo = null;
actionRoute.handler({ body: { action: 'resume', reason: 'html redirect' }, get: () => 'text/html' }, {
  redirect(code, location) { assert.equal(code, 303); redirectedTo = location; },
  status(code) { this.statusCode = code; return this; },
  json() { throw new Error('expected redirect instead of json'); }
});
assert.match(redirectedTo || '', /\/automation\/dashboard\?action=resume&ok=1/);

const suppressIncidentRoute = routes.find((entry) => entry.method === 'POST' && entry.route === '/automation/incidents/:incidentKey/suppress');
assert.ok(suppressIncidentRoute, 'expected suppress incident route');
let suppressIncidentPayload = null;
suppressIncidentRoute.handler({ params: { incidentKey: 'incident-1' } }, {
  json(value) { suppressIncidentPayload = value; },
  status(code) { this.statusCode = code; return this; }
});
assert.equal(suppressIncidentPayload.ok, true);
assert.equal(suppressIncidentPayload.incident.status, 'suppressed');
assert.equal(suppressIncidentPayload.summary.totalActive, 0);

const resolveIncidentRoute = routes.find((entry) => entry.method === 'POST' && entry.route === '/automation/incidents/:incidentKey/resolve');
assert.ok(resolveIncidentRoute, 'expected resolve incident route');

db.prepare(`INSERT INTO active_incidents(incident_key, kind, severity, status, dedupe_key, summary, started_at, last_seen_at, updated_at)
  VALUES ('incident-2', 'worker_stale', 'warn', 'open', 'worker_stale', 'Worker stale.', datetime('now'), datetime('now'), datetime('now'))`).run();
let resolveIncidentPayload = null;
resolveIncidentRoute.handler({ params: { incidentKey: 'incident-2' } }, {
  json(value) { resolveIncidentPayload = value; },
  status(code) { this.statusCode = code; return this; }
});
assert.equal(resolveIncidentPayload.ok, true);
assert.equal(resolveIncidentPayload.incident.status, 'resolved');

db.prepare(`INSERT INTO active_incidents(incident_key, kind, severity, status, dedupe_key, summary, started_at, last_seen_at, updated_at)
  VALUES ('incident-3', 'telegram_delivery_degraded', 'warn', 'open', 'telegram_delivery_degraded', 'Telegram transport degraded.', datetime('now'), datetime('now'), datetime('now'))`).run();
const remediationRoute = routes.find((entry) => entry.method === 'POST' && entry.route === '/automation/remediation/run');
assert.ok(remediationRoute, 'expected /automation/remediation/run route');
let remediationPayload = null;
await remediationRoute.handler({ get: () => 'application/json' }, {
  json(value) { remediationPayload = value; },
  status(code) { this.statusCode = code; return this; }
});
assert.equal(remediationPayload.ok, true);
assert.equal(remediationPayload.result.evaluated >= 1, true);
assert.equal(remediationCalls, 1);

const selfTestsRoute = routes.find((entry) => entry.method === 'GET' && entry.route === '/automation/self-tests');
assert.ok(selfTestsRoute, 'expected /automation/self-tests route');
let denied = null;
const deniedApp = { get(route, handler) { if (route === '/automation/self-tests') denied = handler; }, post() {} };
registerOperatorHttpRoutes({
  app: deniedApp,
  db,
  isAuthorizedControlRequest: () => false,
  rejectUnauthorizedControlRequest: (_req, res) => res.status(403).json({ ok: false, error: 'forbidden' }),
  sendReviewBatch: async () => ({ sent: 0 })
});
let deniedPayload = null;
denied({}, {
  status(code) { this.statusCode = code; return this; },
  json(value) { deniedPayload = value; }
});
assert.equal(deniedPayload.ok, false);
assert.equal(deniedPayload.error, 'forbidden');

console.log('Operator dashboard validation passed');
