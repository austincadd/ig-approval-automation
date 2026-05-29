import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  getAutomationStatus,
  pauseAutomation,
  resumeAutomation,
  requeueBlockedJobs,
  reconcileApprovedQueue,
  suppressRecoveryCandidate,
  claimNextQueuedJob
} from '../core/recovery.js';

const schema = fs.readFileSync(path.resolve('db/schema.sql'), 'utf8');
const db = new Database(':memory:');
db.exec(schema);

const insertCandidate = db.prepare(`INSERT INTO candidates(post_url, source) VALUES (?, 'test')`);
const approve = db.prepare(`INSERT INTO approvals(candidate_id, decision, decided_by) VALUES (?, 'approved', 'test')`);
const insertJob = db.prepare(`
  INSERT INTO like_jobs(candidate_id, status, started_at, finished_at, error_code, error_message, created_at, updated_at)
  VALUES (?, ?, NULL, NULL, NULL, NULL, datetime('now'), datetime('now'))
`);

insertCandidate.run('https://instagram.com/p/a');
insertCandidate.run('https://instagram.com/p/b');
insertCandidate.run('https://instagram.com/p/c');

approve.run(1);
approve.run(2);
approve.run(3);
assert.throws(() => approve.run(1), /UNIQUE|unique/i, 'approval uniqueness should be enforced');
insertJob.run(1, 'blocked');
insertJob.run(3, 'success');

const paused = pauseAutomation(db, { actor: 'test' });
assert.equal(paused.automationEnabled, false);
const resumed = resumeAutomation(db, { actor: 'test' });
assert.equal(resumed.automationEnabled, true);
assert.equal(resumed.approvedWithoutActive, 2, 'resume should surface drift count so operators know enable != queued');
assert.deepEqual(resumed.approvedWithoutActiveCandidates.map((row) => row.candidateId), [1, 2], 'resume should surface ordered drift detail rows');

const reconciled = reconcileApprovedQueue(db, { actor: 'test' });
assert.equal(reconciled.createdCount, 2, 'should queue approved candidates missing active/success jobs');
assert.equal(reconcileApprovedQueue(db, { actor: 'test' }).createdCount, 0, 'reconcile should be idempotent with active jobs present');

const firstClaim = claimNextQueuedJob(db);
assert.ok(firstClaim, 'expected a claimed job');
assert.equal(firstClaim.candidate_id, 1);
assert.equal(claimNextQueuedJob(db)?.candidate_id, 2);
assert.equal(claimNextQueuedJob(db), null);

// Reset candidate 1 into blocked, then ensure requeue creates a fresh queued row rather than mutating history.
db.prepare(`UPDATE like_jobs SET status='blocked', finished_at=datetime('now'), updated_at=datetime('now') WHERE id = ?`).run(firstClaim.id);
const beforeCount = db.prepare(`SELECT COUNT(*) AS count FROM like_jobs WHERE candidate_id = 1`).get().count;
const requeued = requeueBlockedJobs(db, { actor: 'test' });
assert.equal(requeued.createdCount, 1);
const afterCount = db.prepare(`SELECT COUNT(*) AS count FROM like_jobs WHERE candidate_id = 1`).get().count;
assert.equal(afterCount, beforeCount + 1, 'requeue should insert a new queued job');
assert.equal(requeueBlockedJobs(db, { actor: 'test' }).createdCount, 0, 'requeue should be idempotent while active queued job exists');

const suppressed = suppressRecoveryCandidate(db, { actor: 'test', candidateId: 2, reason: 'duplicate_live_success' });
assert.equal(suppressed.status, 'ok');
assert.equal(suppressed.changed, true);
assert.equal(reconcileApprovedQueue(db, { actor: 'test' }).createdCount, 0, 'suppressed candidates should not be re-reconciled');

const status = getAutomationStatus(db);
assert.equal(status.status, 'ok');
assert.ok(typeof status.counts.blocked === 'number');
assert.equal(status.approvedWithoutActive, 0, 'final state should have no approval drift after reconcile + requeue');
assert.equal(status.approvedWithoutActiveCandidates.length, 0, 'final state should clear drift detail rows');
assert.equal(status.recoverySuppressedCount, 1, 'status should report suppressed recovery candidates');
assert.deepEqual(status.recoverySuppressedCandidates.map((row) => row.candidateId), [2], 'status should include suppressed candidate detail');

console.log('Recovery validation passed');
