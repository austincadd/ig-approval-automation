import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';

const repoRoot = path.resolve('.');
const schema = fs.readFileSync(path.join(repoRoot, 'db/schema.sql'), 'utf8');
const timestampPattern = /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] /m;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition, { timeoutMs = 1500, pollMs = 20, label = 'condition' } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await condition()) return Date.now() - start;
    await sleep(pollMs);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function createHarnessDb({ automationEnabled, queuedJobs = 0 }) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-worker-loop-'));
  const dbPath = path.join(tempDir, 'test.db');
  const db = new Database(dbPath);
  db.exec(schema);
  db.prepare(`UPDATE system_flags SET value = ? WHERE key = 'AUTOMATION_ENABLED'`).run(automationEnabled ? 'true' : 'false');

  const insertCandidate = db.prepare(`INSERT INTO candidates(post_url, source) VALUES (?, 'test')`);
  const insertJob = db.prepare(`INSERT INTO like_jobs(candidate_id, status) VALUES (?, 'queued')`);
  for (let i = 0; i < queuedJobs; i += 1) {
    const candidate = insertCandidate.run(`https://instagram.com/p/test-${i + 1}`);
    insertJob.run(Number(candidate.lastInsertRowid));
  }

  return { tempDir, dbPath, db };
}

function writeWorkerOnceStub(tempDir) {
  const repoTmpDir = path.join(repoRoot, 'tmp');
  fs.mkdirSync(repoTmpDir, { recursive: true });
  const stubPath = path.join(repoTmpDir, `worker-once-stub-${path.basename(tempDir)}.js`);
  fs.writeFileSync(stubPath, `
import path from 'node:path';
import Database from 'better-sqlite3';
import { installTimestampedConsole } from '../scripts/lib/timestamped-console.js';

installTimestampedConsole();

const db = new Database(path.resolve(process.env.IG_AUTOMATION_DB_PATH));
const row = db.prepare("SELECT id FROM like_jobs WHERE status='queued' ORDER BY datetime(created_at) ASC, id ASC LIMIT 1").get();
if (row) {
  db.prepare(\`UPDATE like_jobs
    SET status='success',
        started_at=datetime('now'),
        finished_at=datetime('now'),
        updated_at=datetime('now'),
        attempt_count=attempt_count + 1
    WHERE id=?\`).run(row.id);
  console.log(\`Stub success job \${row.id}\`);
} else {
  console.log('Stub saw no queued jobs');
}
db.close();
`, 'utf8');
  return stubPath;
}

async function spawnLoopHarness({
  automationEnabled,
  queuedJobs = 0,
  idlePollMs = 1000,
  pausedPollMs = 1000,
  cooldownMs = 1000,
  wakePollMs = 100,
  disableFsWatch = false
}) {
  const { tempDir, dbPath, db } = createHarnessDb({ automationEnabled, queuedJobs });
  const workerOnceScript = writeWorkerOnceStub(tempDir);

  const child = spawn('node', ['scripts/run-worker-loop.js'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      IG_AUTOMATION_DB_PATH: dbPath,
      WORKER_ONCE_SCRIPT: workerOnceScript,
      WORKER_COOLDOWN_MIN_MS: String(cooldownMs),
      WORKER_COOLDOWN_MAX_MS: String(cooldownMs),
      WORKER_PAUSED_POLL_MS: String(pausedPollMs),
      WORKER_IDLE_POLL_MS: String(idlePollMs),
      WORKER_WAKE_POLL_MS: String(wakePollMs),
      WORKER_DISABLE_FS_WATCH: disableFsWatch ? '1' : '0'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });

  async function cleanup() {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
    db.close();
    fs.rmSync(workerOnceScript, { force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  return { db, stdoutRef: () => stdout, stderrRef: () => stderr, cleanup };
}

const paused = await spawnLoopHarness({ automationEnabled: false, pausedPollMs: 200, wakePollMs: 50 });
await waitFor(() => paused.stdoutRef().includes('Automation paused; worker idle until resumed.'), { label: 'paused log' });
await sleep(250);
assert.equal(paused.stderrRef().trim(), '', 'paused loop should not error');
assert.match(paused.stdoutRef(), timestampPattern, 'paused loop logs should include timestamps');
assert.equal((paused.stdoutRef().match(/Automation paused; worker idle until resumed\./g) || []).length, 1, 'paused loop should log once per paused idle period');
await paused.cleanup();

const idle = await spawnLoopHarness({ automationEnabled: true, queuedJobs: 0, idlePollMs: 200, wakePollMs: 50 });
await waitFor(() => idle.stdoutRef().includes('No queued jobs; worker idle.'), { label: 'idle log' });
await sleep(250);
assert.equal(idle.stderrRef().trim(), '', 'idle loop should not error');
assert.equal((idle.stdoutRef().match(/No queued jobs; worker idle\./g) || []).length, 1, 'idle loop should log once while queue is empty');
await idle.cleanup();

const idleWake = await spawnLoopHarness({ automationEnabled: true, queuedJobs: 0, idlePollMs: 2000, wakePollMs: 50 });
await waitFor(() => idleWake.stdoutRef().includes('No queued jobs; worker idle.'), { label: 'idle wake baseline' });
const idleInsertCandidate = idleWake.db.prepare(`INSERT INTO candidates(post_url, source) VALUES (?, 'test')`).run('https://instagram.com/p/idle-wake');
const idleInsertStartedAt = Date.now();
idleWake.db.prepare(`INSERT INTO like_jobs(candidate_id, status) VALUES (?, 'queued')`).run(Number(idleInsertCandidate.lastInsertRowid));
const idleWakeLatency = await waitFor(() => idleWake.stdoutRef().includes('Stub success job 1'), { timeoutMs: 1600, label: 'idle wake claim' });
assert.ok(idleWake.stdoutRef().includes('Worker wake signal: database changed.'), 'idle wake should log db-change wake');
assert.ok(idleWakeLatency < 1600, `idle wake should claim well before 2s idle poll, got ${idleWakeLatency}ms`);
assert.ok(Date.now() - idleInsertStartedAt < 1800, 'idle wake should not wait for full idle poll interval');
assert.equal(idleWake.db.prepare(`SELECT status FROM like_jobs ORDER BY id DESC LIMIT 1`).get()?.status, 'success', 'idle wake job should be claimed successfully');
await idleWake.cleanup();

const pollingWake = await spawnLoopHarness({ automationEnabled: true, queuedJobs: 0, idlePollMs: 2000, wakePollMs: 50, disableFsWatch: true });
await waitFor(() => pollingWake.stdoutRef().includes('No queued jobs; worker idle.'), { label: 'polling wake baseline' });
const pollingInsertCandidate = pollingWake.db.prepare(`INSERT INTO candidates(post_url, source) VALUES (?, 'test')`).run('https://instagram.com/p/polling-wake');
pollingWake.db.prepare(`INSERT INTO like_jobs(candidate_id, status) VALUES (?, 'queued')`).run(Number(pollingInsertCandidate.lastInsertRowid));
const pollingWakeLatency = await waitFor(() => pollingWake.stdoutRef().includes('Stub success job 1'), { timeoutMs: 1200, label: 'polling wake claim' });
assert.ok(pollingWake.stdoutRef().includes('Worker wake signal: database changed.'), 'polling wake should still log db-change wake without fs.watch');
assert.ok(pollingWakeLatency < 1200, `polling wake should claim before idle timeout when fs.watch is disabled, got ${pollingWakeLatency}ms`);
await pollingWake.cleanup();

const cooldownWake = await spawnLoopHarness({ automationEnabled: true, queuedJobs: 1, cooldownMs: 3000, wakePollMs: 50 });
await waitFor(() => cooldownWake.stdoutRef().includes('Stub success job 1'), { timeoutMs: 1200, label: 'first stub success' });
await sleep(300);
const cooldownInsertCandidate = cooldownWake.db.prepare(`INSERT INTO candidates(post_url, source) VALUES (?, 'test')`).run('https://instagram.com/p/cooldown-wake');
const cooldownInsertStartedAt = Date.now();
cooldownWake.db.prepare(`INSERT INTO like_jobs(candidate_id, status) VALUES (?, 'queued')`).run(Number(cooldownInsertCandidate.lastInsertRowid));
const cooldownWakeLatency = await waitFor(() => cooldownWake.stdoutRef().includes('Stub success job 2'), { timeoutMs: 2200, label: 'cooldown wake claim' });
assert.ok(cooldownWake.stdoutRef().includes('Worker wake signal: database changed.'), 'cooldown wake should log db-change wake');
assert.ok(cooldownWakeLatency < 2200, `cooldown wake should claim well before 3s cooldown, got ${cooldownWakeLatency}ms`);
assert.ok(Date.now() - cooldownInsertStartedAt < 2500, 'cooldown wake should not wait for full cooldown interval');
assert.equal(cooldownWake.db.prepare(`SELECT status FROM like_jobs WHERE id = 2`).get()?.status, 'success', 'cooldown wake job should be claimed successfully');
await cooldownWake.cleanup();

const backlogPolicy = await spawnLoopHarness({ automationEnabled: true, queuedJobs: 2, cooldownMs: 1200, wakePollMs: 50 });
await waitFor(() => backlogPolicy.stdoutRef().includes('Stub success job 1'), { timeoutMs: 1200, label: 'backlog first success' });
await sleep(350);
assert.equal((backlogPolicy.stdoutRef().match(/Stub success job/g) || []).length, 1, 'pre-existing backlog should still honor cooldown between runs');
await waitFor(() => backlogPolicy.stdoutRef().includes('Stub success job 2'), { timeoutMs: 1400, label: 'backlog second success after cooldown' });
await backlogPolicy.cleanup();

console.log('Worker loop validation passed');
