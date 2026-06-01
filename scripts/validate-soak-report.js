import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getSoakReport } from '../core/soak-report.js';

const schema = fs.readFileSync(path.resolve('db/schema.sql'), 'utf8');
const db = new Database(':memory:');
db.exec(schema);

db.prepare(`INSERT INTO candidates(post_url, source) VALUES ('https://instagram.com/p/a', 'test')`).run();
db.prepare(`INSERT INTO like_jobs(candidate_id, status, created_at, updated_at, finished_at) VALUES (1, 'success', datetime('now','-1 hour'), datetime('now','-1 hour'), datetime('now','-1 hour'))`).run();
db.prepare(`INSERT INTO run_events(level, event_type, payload_json, created_at) VALUES ('error', 'incident_recovery_failed', json(?), datetime('now','-50 minutes'))`).run(JSON.stringify({ incidentKey: 'i1' }));
db.prepare(`INSERT INTO run_events(level, event_type, payload_json, created_at) VALUES ('info', 'incident_recovery_succeeded', json(?), datetime('now','-40 minutes'))`).run(JSON.stringify({ incidentKey: 'i1' }));
db.prepare(`INSERT INTO run_events(level, event_type, payload_json, created_at) VALUES ('warn', 'worker_readiness_blocked', json(?), datetime('now','-30 minutes'))`).run(JSON.stringify({ readiness: { state: 'blocked' } }));
db.prepare(`INSERT INTO active_incidents(incident_key, kind, severity, status, dedupe_key, summary, started_at, last_seen_at, resolved_at, updated_at) VALUES ('cp1', 'control_plane_stale', 'critical', 'resolved', 'control_plane_stale', 'cp stale', datetime('now','-20 minutes'), datetime('now','-10 minutes'), datetime('now','-10 minutes'), datetime('now','-10 minutes'))`).run();

const report = getSoakReport(db, { days: 7 });
assert.equal(report.windowDays, 7);
assert.equal(report.summary.criticalIncidents, 1);
assert.equal(report.summary.autoRecoveryFailures, 1);
assert.equal(report.summary.autoRecoverySuccesses, 1);
assert.equal(report.summary.readinessBlocks, 1);
assert.ok(report.summary.controlPlaneStaleMinutes >= 10);

console.log('Soak report validation passed');
