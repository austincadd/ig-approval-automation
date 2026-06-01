import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getOperatorAutomationStatus, formatOperatorAutomationStatus } from '../core/automation-status.js';

const schema = fs.readFileSync(path.resolve('db/schema.sql'), 'utf8');
const db = new Database(':memory:');
db.exec(schema);

const insertCandidate = db.prepare(`INSERT INTO candidates(post_url, source) VALUES (?, 'test')`);
const insertApproval = db.prepare(`INSERT INTO approvals(candidate_id, decision, decided_by) VALUES (?, ?, 'test')`);
const insertJob = db.prepare(`
  INSERT INTO like_jobs(candidate_id, status, started_at, finished_at, error_code, error_message, failure_class, failure_policy, evidence_bundle_path, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
`);
const insertEvent = db.prepare(`
  INSERT INTO run_events(job_id, level, event_type, payload_json, created_at)
  VALUES (?, ?, ?, ?, ?)
`);

insertCandidate.run('https://instagram.com/p/a');
insertCandidate.run('https://instagram.com/p/b');
insertCandidate.run('https://instagram.com/p/c');
insertApproval.run(1, 'approved');
insertApproval.run(2, 'approved');
insertApproval.run(3, 'skipped');
insertJob.run(1, 'running', '2026-05-27 10:00:00', null, null, null, null, null, null);
insertJob.run(2, 'blocked', '2026-05-27 09:00:00', '2026-05-27 09:05:00', 'CHECKPOINT_DETECTED', 'Challenge detected', 'account_challenge', 'require_operator_action', 'artifacts/failures/2026-05-27/job-2');
insertEvent.run(2, 'error', 'job_blocked', JSON.stringify({ error: { code: 'CHECKPOINT_DETECTED' } }), '2026-05-27 09:05:00');
insertJob.run(2, 'success', '2026-05-27 11:00:00', '2026-05-27 11:01:00', null, null, null, null, null);
insertJob.run(3, 'failed', '2026-05-27 08:00:00', '2026-05-27 08:03:00', 'LIKE_BUTTON_NOT_FOUND', 'Primary control missing', 'selector_drift', 'pause_executor', 'artifacts/failures/2026-05-27/job-4');
insertEvent.run(4, 'error', 'job_failed', JSON.stringify({ error: { code: 'LIKE_BUTTON_NOT_FOUND' } }), '2026-05-27 08:03:00');

db.prepare(`
  INSERT INTO system_flags(key, value, updated_at)
  VALUES ('EXECUTOR_CANARY_RESULT', ?, datetime('now'))
`).run(JSON.stringify({ ok: false, code: 'CANARY_ACTION_SURFACE_MISSING', state: 'degraded', startedAt: '2026-05-27T14:01:00.000Z' }));
db.prepare(`
  INSERT INTO system_flags(key, value, updated_at)
  VALUES ('TELEGRAM_TRANSPORT_HEALTH', ?, datetime('now'))
`).run(JSON.stringify({ status: 'degraded', restartAttempts: 2, duplicatePollerDetected: false, sendFailures: 1, pollingErrors: 3, lastError: 'timeout', updatedAt: '2026-05-27T14:02:00.000Z' }));
db.prepare(`
  INSERT INTO self_test_results(test_key, status, summary, details_json, checked_at, updated_at)
  VALUES ('db_integrity', 'ok', 'queue sane', '{}', datetime('now'), datetime('now'))
`).run();
db.prepare(`
  INSERT INTO active_incidents(incident_key, kind, severity, status, dedupe_key, summary, started_at, last_seen_at, updated_at)
  VALUES ('telegram-1', 'telegram_delivery_degraded', 'warn', 'open', 'telegram_delivery_degraded', 'Telegram transport degraded.', '2026-05-27 07:00:00', '2026-05-27 07:05:00', '2026-05-27 07:05:00')
`).run();

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-automation-status-'));
const lockPath = path.join(tempDir, 'telegram-bot.lock');
const outLog = path.join(tempDir, 'worker.out.log');
const errLog = path.join(tempDir, 'worker.err.log');
fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: '2026-05-27T14:00:00.000Z', label: 'telegram bot/callback server' }));
fs.writeFileSync(outLog, '[2026-05-27T14:03:00.000Z] Worker active\n');
fs.writeFileSync(errLog, '[2026-05-27T14:02:00.000Z] Failed job 2: Challenge detected\n');

const status = getOperatorAutomationStatus(db, {
  telegramBotLockPath: lockPath,
  workerLaunchdLabel: 'com.example.missing-worker',
  workerStdoutLogPath: outLog,
  workerStderrLogPath: errLog,
  failureLimit: 5
});

assert.equal(status.status, 'ok');
assert.equal(status.bot.health, 'running');
assert.equal(status.bot.pid, process.pid);
assert.ok(['not_running', 'unknown'].includes(status.worker.health));
assert.equal(status.worker.lastStartedAt, '2026-05-27 11:00:00');
assert.equal(status.worker.lastTerminalFailureAt, '2026-05-27 09:05:00');
assert.equal(status.counts.running, 1);
assert.equal(status.counts.blocked, 1);
assert.equal(status.counts.failed, 1);
assert.equal(status.approvedWithoutActive, 0);
assert.equal(status.recentTerminalFailures.length, 2);
assert.equal(status.recentTerminalFailures[0].failureClass, 'selector_drift');
assert.equal(status.recentTerminalFailures[0].evidenceBundlePath, 'artifacts/failures/2026-05-27/job-4');
assert.equal(status.worker.stdoutLog.lastLine, '[2026-05-27T14:03:00.000Z] Worker active');
assert.equal(status.worker.stderrLog.lastLine, '[2026-05-27T14:02:00.000Z] Failed job 2: Challenge detected');
assert.equal(status.health.state, 'degraded');
assert.equal(status.health.controlPlane, 'ok');
assert.equal(status.health.executor, 'degraded');
assert.equal(status.health.delivery, 'degraded');
assert.equal(status.health.account, 'degraded');
assert.equal(status.selfTests.summary.total, 1);
assert.equal(status.policyVersions.selectorStrategyVersion, 'v2.0');
assert.equal(status.readiness.ok, true);
assert.equal(status.readiness.state, 'degraded');
assert.ok(status.executorOwner);
assert.equal(status.activeBlockerCount, 1);
assert.equal(status.historicalBlockedCount, 1);
assert.equal(status.currentBlocked[0].candidateId, 3);
assert.equal(status.historicalBlocked[0].candidateId, 2);
assert.equal(status.incidents.summary.totalActive, 2);
assert.equal(status.incidents.summary.bySeverity.warn, 2);
assert.equal(status.incidents.summary.bySeverity.critical, 0);
assert.ok(status.incidents.active.some((incident) => incident.kind === 'telegram_delivery_degraded'));
assert.ok(status.incidents.active.some((incident) => incident.kind === 'worker_stale'));

const text = formatOperatorAutomationStatus(status);
assert.match(text, /Automation:/);
assert.match(text, /Health: degraded \| control=ok/);
assert.match(text, /Canary: CANARY_ACTION_SURFACE_MISSING/);
assert.match(text, /Incidents: active=2 critical=0 warn=2/);
assert.match(text, /Readiness: degraded/);
assert.match(text, /Executor owner:/);
assert.match(text, /SLO: /);
assert.match(text, /Soak\(7d\): /);
assert.match(text, /Current blockers: 1 \| Historical blocked: 1/);
assert.match(text, /Self-tests: overall=ok/);
assert.match(text, /Policy versions: schema=2026-05-29.phase5/);

const staleLockPath = path.join(tempDir, 'telegram-bot-stale.lock');
fs.writeFileSync(staleLockPath, JSON.stringify({ pid: 999999, startedAt: '2026-05-27T14:00:00.000Z', label: 'telegram bot/callback server' }));
const staleStatus = getOperatorAutomationStatus(db, {
  telegramBotLockPath: staleLockPath,
  workerLaunchdLabel: 'com.example.missing-worker',
  workerStdoutLogPath: outLog,
  workerStderrLogPath: errLog,
  failureLimit: 5
});
assert.equal(staleStatus.health.controlPlane, 'stale');
assert.equal(staleStatus.health.state, 'degraded');
assert.ok(staleStatus.incidents.active.some((incident) => incident.kind === 'control_plane_stale'));

console.log('Automation status validation passed');
