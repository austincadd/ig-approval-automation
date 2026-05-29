import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getReliabilityMetrics } from '../core/metrics.js';

const schema = fs.readFileSync(path.resolve('db/schema.sql'), 'utf8');
const db = new Database(':memory:');
db.exec(schema);

const insertCandidate = db.prepare(`INSERT INTO candidates(post_url, source) VALUES (?, 'test')`);
const insertJob = db.prepare(`
  INSERT INTO like_jobs(candidate_id, status, finished_at, error_code, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const insertEvent = db.prepare(`INSERT INTO run_events(job_id, level, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)`);

insertCandidate.run('https://instagram.com/p/1');
insertCandidate.run('https://instagram.com/p/2');
insertCandidate.run('https://instagram.com/p/3');
insertJob.run(1, 'success', '2099-05-28 12:00:00', null, '2099-05-28 12:00:00', '2099-05-28 12:00:00');
insertJob.run(2, 'failed', '2099-05-28 13:00:00', 'LIKE_BUTTON_NOT_FOUND', '2099-05-28 13:00:00', '2099-05-28 13:00:00');
insertJob.run(3, 'blocked', '2099-05-29 14:00:00', 'CHECKPOINT_DETECTED', '2099-05-29 14:00:00', '2099-05-29 14:00:00');
insertEvent.run(1, 'info', 'job_success', JSON.stringify({ pageShape: 'feed_post', outcome: 'clicked_and_verified' }), '2099-05-28 12:00:00');
insertEvent.run(2, 'error', 'job_failed', JSON.stringify({ pageShape: 'reel', error: { code: 'LIKE_BUTTON_NOT_FOUND' } }), '2099-05-28 13:00:00');
insertEvent.run(3, 'error', 'job_blocked', JSON.stringify({ pageShape: 'reel', error: { code: 'CHECKPOINT_DETECTED' } }), '2099-05-29 14:00:00');
insertEvent.run(null, 'warn', 'telegram_transport_health_changed', JSON.stringify({ status: 'degraded' }), '2099-05-28 10:00:00');
insertEvent.run(null, 'info', 'telegram_transport_health_changed', JSON.stringify({ status: 'ok' }), '2099-05-28 11:00:00');
insertEvent.run(null, 'info', 'automation_paused', JSON.stringify({ actor: 'worker' }), '2099-05-28 10:00:00');
insertEvent.run(null, 'info', 'automation_resumed', JSON.stringify({ actor: 'telegram:austin' }), '2099-05-28 10:30:00');

const metrics = getReliabilityMetrics(db, { days: 30000 });
assert.equal(metrics.summary.successCount, 1);
assert.equal(metrics.summary.terminalCount, 3);
assert.equal(metrics.summary.successRate, 0.3333);
assert.equal(metrics.summary.selectorFailureRate, 0.3333);
assert.equal(metrics.summary.challengeIncidenceRate, 0.3333);
assert.equal(metrics.summary.telegramDeliveryDegradationRate, 0.5);
assert.equal(metrics.summary.meanTimeToOperatorInterventionMinutes, 30);
assert.ok(metrics.byPageShape.find((row) => row.pageShape === 'reel'));
assert.ok(metrics.byPageShape.find((row) => row.pageShape === 'feed_post'));

console.log('Metrics validation passed');
