import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createControlPlaneAuth } from '../bot/control-plane-auth.js';
import { createCommandTaskRunner } from '../bot/command-task-runner.js';
import { createTelegramTransportHealthStore } from '../bot/telegram-transport-health.js';
import { createTelegramResultReporter } from '../bot/telegram-result-reporter.js';
import { buildTelegramResultNotificationBatches, readTelegramResultCursor, writeTelegramResultCursor } from '../core/telegram-result-reporting.js';

const schema = fs.readFileSync(path.resolve('db/schema.sql'), 'utf8');
const db = new Database(':memory:');
db.exec(schema);

const auth = createControlPlaneAuth({ chatId: '123', controlToken: 'secret-token', bindHost: '0.0.0.0' });
assert.equal(auth.requireAuthorizedChat(123), true);
assert.equal(auth.requireAuthorizedUser(undefined), true, 'missing Telegram user id should not fail auth on chat-scoped surfaces');
assert.equal(auth.isAuthorizedActor({ chatIdValue: 123, userIdValue: undefined }), true);
assert.equal(auth.isAuthorizedControlRequest({
  socket: { remoteAddress: '127.0.0.1' },
  ip: '127.0.0.1',
  get: () => ''
}), false, 'non-loopback bind should require explicit control token');
assert.equal(auth.isAuthorizedControlRequest({
  socket: { remoteAddress: '10.0.0.5' },
  ip: '10.0.0.5',
  get: () => 'secret-token'
}), true, 'valid control token should authorize remote requests');

const runner = createCommandTaskRunner();
await assert.rejects(() => runner.enqueueCommandTask(null), /requires a function task/);
const order = [];
await Promise.all([
  runner.enqueueCommandTask(async () => {
    order.push('a:start');
    await new Promise((resolve) => setTimeout(resolve, 20));
    order.push('a:end');
  }),
  runner.enqueueCommandTask(async () => {
    order.push('b:start');
    order.push('b:end');
  })
]);
assert.deepEqual(order, ['a:start', 'a:end', 'b:start', 'b:end'], 'task runner should serialize queued tasks');

const transportHealth = createTelegramTransportHealthStore(db);
transportHealth.writeTransportHealth({ status: 'degraded', sendFailures: 1, lastError: 'timeout' });
transportHealth.writeTransportHealth({ status: 'degraded', sendFailures: 1, lastError: 'timeout' });
transportHealth.writeTransportHealth({ status: 'ok', sendFailures: 0, lastError: null });
const healthEvents = db.prepare(`SELECT level, payload_json FROM run_events WHERE event_type='telegram_transport_health_changed' ORDER BY id ASC`).all();
assert.equal(healthEvents.length, 2, 'health changes should not log duplicate entries when only updatedAt changes');
assert.match(healthEvents[0].payload_json, /"status":"degraded"/);
assert.match(healthEvents[1].payload_json, /"status":"ok"/);

const insertCandidate = db.prepare(`INSERT INTO candidates(post_url, source) VALUES (?, 'test')`);
const insertJob = db.prepare(`
  INSERT INTO like_jobs(candidate_id, status, error_code, error_message, failure_class, failure_policy, evidence_bundle_path, finished_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
`);
const insertEvent = db.prepare(`
  INSERT INTO run_events(job_id, level, event_type, payload_json)
  VALUES (?, ?, ?, ?)
`);

const longMessageA = 'missing '.repeat(260);
const longMessageB = 'challenge '.repeat(260);
const longEvidenceA = `artifact-a/${'x'.repeat(2200)}`;
const longEvidenceB = `artifact-b/${'y'.repeat(2200)}`;
const candidateA = Number(insertCandidate.run('https://www.instagram.com/p/AAA111/'.padEnd(520, 'a')).lastInsertRowid);
const candidateB = Number(insertCandidate.run('https://www.instagram.com/p/BBB222/'.padEnd(520, 'b')).lastInsertRowid);
const candidateC = Number(insertCandidate.run('https://www.instagram.com/p/CCC333/'.padEnd(520, 'c')).lastInsertRowid);
const jobA = Number(insertJob.run(candidateA, 'failed', 'LIKE_BUTTON_NOT_FOUND', longMessageA, 'selector_drift', 'pause_executor', longEvidenceA).lastInsertRowid);
const jobB = Number(insertJob.run(candidateB, 'blocked', 'CHECKPOINT_DETECTED', longMessageB, 'account_challenge', 'require_operator_action', longEvidenceB).lastInsertRowid);
const jobC = Number(insertJob.run(candidateC, 'success', null, null, null, null, null).lastInsertRowid);
insertEvent.run(jobA, 'error', 'job_failed', JSON.stringify({ error: { code: 'LIKE_BUTTON_NOT_FOUND', message: longMessageA } }));
insertEvent.run(jobB, 'error', 'job_blocked', JSON.stringify({ error: { code: 'CHECKPOINT_DETECTED', message: longMessageB } }));
insertEvent.run(jobC, 'info', 'job_success', JSON.stringify({ outcome: 'clicked_and_verified' }));

const unread = db.prepare(`SELECT id FROM run_events WHERE event_type IN ('job_failed','job_blocked','job_success') ORDER BY id ASC`).all();
writeTelegramResultCursor(db, unread[0].id - 1);
const events = db.prepare(`
  SELECT re.id, re.job_id, re.event_type, re.payload_json, re.created_at, lj.candidate_id, c.post_url, lj.error_code, lj.error_message, lj.failure_class, lj.failure_policy, lj.evidence_bundle_path
  FROM run_events re
  JOIN like_jobs lj ON lj.id = re.job_id
  JOIN candidates c ON c.id = lj.candidate_id
  WHERE re.id > ? AND re.event_type IN ('job_failed','job_blocked','job_success')
  ORDER BY re.id ASC
`).all(unread[0].id - 1).map((row) => ({ ...row, payload: JSON.parse(row.payload_json) }));
const batches = buildTelegramResultNotificationBatches(events, { maxMessageLength: 220 });
assert.equal(batches.length, 3, 'tight max length should create multiple independently-acknowledgeable batches');
assert.equal(batches[0].lastEventId, events[0].id);
assert.equal(batches[2].lastEventId, events[2].id);

const sent = [];
let sendCount = 0;
const reporter = createTelegramResultReporter({
  db,
  pollMs: 60_000,
  safeSendMessage: async (message) => {
    sent.push(message);
    sendCount += 1;
    return sendCount < 3;
  },
  writeTransportHealth: () => {}
});
await reporter.pollAndReportJobResults();
assert.equal(sent.length, 3, 'reporter should attempt batches in order until first send failure');
assert.equal(readTelegramResultCursor(db), events[1].id, 'cursor should advance through last successfully delivered batch');

console.log('Control-plane seam validation passed');
