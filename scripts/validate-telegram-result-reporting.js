import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  buildTelegramResultNotifications,
  formatTelegramJobResultMessage,
  getLatestTelegramResultEventId,
  initializeTelegramResultCursor,
  readTelegramResultCursor,
  readTelegramResultEvents,
  writeTelegramResultCursor
} from '../core/telegram-result-reporting.js';

const schema = fs.readFileSync(path.resolve('db/schema.sql'), 'utf8');
const db = new Database(':memory:');
db.exec(schema);

const insertCandidate = db.prepare(`INSERT INTO candidates(post_url, source) VALUES (?, 'test')`);
const insertJob = db.prepare(`
  INSERT INTO like_jobs(candidate_id, status, error_code, error_message, failure_class, failure_policy, evidence_bundle_path, finished_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
`);
const insertEvent = db.prepare(`
  INSERT INTO run_events(job_id, level, event_type, payload_json)
  VALUES (?, ?, ?, ?)
`);

const candidateA = Number(insertCandidate.run('https://www.instagram.com/p/AAA111/').lastInsertRowid);
const candidateB = Number(insertCandidate.run('https://www.instagram.com/p/BBB222/').lastInsertRowid);
const candidateC = Number(insertCandidate.run('https://www.instagram.com/p/CCC333/').lastInsertRowid);

const jobSuccess = Number(insertJob.run(candidateA, 'success', null, null, null, null, null).lastInsertRowid);
insertEvent.run(jobSuccess, 'info', 'job_success', JSON.stringify({ outcome: 'clicked_and_verified' }));

assert.equal(getLatestTelegramResultEventId(db), 1, 'latest terminal result event id should reflect inserted success event');
assert.equal(readTelegramResultCursor(db), null, 'cursor should start unset');
assert.equal(initializeTelegramResultCursor(db), 1, 'initialization should snap cursor to latest existing event');
assert.equal(readTelegramResultCursor(db), 1, 'initialized cursor should be persisted');

const jobFailed = Number(insertJob.run(candidateB, 'failed', 'LIKE_BUTTON_NOT_FOUND', 'primary action row missing', 'selector_drift', 'pause_executor', 'artifacts/failures/2026-05-28/job-2').lastInsertRowid);
insertEvent.run(jobFailed, 'error', 'job_failed', JSON.stringify({
  error: {
    code: 'LIKE_BUTTON_NOT_FOUND',
    message: 'primary action row missing after readiness retry'
  }
}));

const jobBlocked = Number(insertJob.run(candidateC, 'blocked', 'CHECKPOINT_DETECTED', 'challenge surfaced', 'account_challenge', 'require_operator_action', 'artifacts/failures/2026-05-28/job-3').lastInsertRowid);
insertEvent.run(jobBlocked, 'error', 'job_blocked', JSON.stringify({
  error: {
    code: 'CHECKPOINT_DETECTED',
    message: 'challenge surfaced before like action'
  }
}));

const unread = readTelegramResultEvents(db, { afterId: readTelegramResultCursor(db), limit: 10 });
assert.equal(unread.length, 2, 'only post-initialization events should be unread');
assert.deepEqual(unread.map((event) => event.event_type), ['job_failed', 'job_blocked']);
assert.equal(unread[0].candidate_id, candidateB);
assert.equal(unread[1].candidate_id, candidateC);
assert.equal(unread[0].failure_class, 'selector_drift');
assert.equal(unread[1].failure_policy, 'require_operator_action');

const failedMessage = formatTelegramJobResultMessage(unread[0]);
assert.match(failedMessage, /❌ Job failed/);
assert.match(failedMessage, new RegExp(`Candidate: ${candidateB}`));
assert.match(failedMessage, new RegExp(`Job: ${jobFailed}`));
assert.match(failedMessage, /LIKE_BUTTON_NOT_FOUND/);
assert.match(failedMessage, /Class: selector_drift/);
assert.match(failedMessage, /Policy: pause_executor/);
assert.match(failedMessage, /Evidence: artifacts\/failures\/2026-05-28\/job-2/);

const blockedMessage = formatTelegramJobResultMessage(unread[1]);
assert.match(blockedMessage, /⛔ Job blocked/);
assert.match(blockedMessage, /CHECKPOINT_DETECTED/);
assert.match(blockedMessage, /Policy: require_operator_action/);
assert.match(blockedMessage, /clear browser state before retrying/i);

const notifications = buildTelegramResultNotifications(unread, { maxMessageLength: 10000 });
assert.equal(notifications.length, 1, 'multiple unread events should coalesce into one Telegram send when they fit');
assert.match(notifications[0], /❌ Job failed/);
assert.match(notifications[0], /⛔ Job blocked/);

const splitNotifications = buildTelegramResultNotifications(unread, { maxMessageLength: 120 });
assert.equal(splitNotifications.length, 2, 'message builder should split oversized batches');

writeTelegramResultCursor(db, unread[unread.length - 1].id);
assert.equal(readTelegramResultCursor(db), 3, 'cursor should advance after reporting');
assert.deepEqual(readTelegramResultEvents(db, { afterId: readTelegramResultCursor(db), limit: 10 }), [], 'no unread events should remain after cursor advance');

console.log('Telegram result reporting validation passed');
