import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { run } from '../worker/run-once.js';

const schema = fs.readFileSync(path.resolve('db/schema.sql'), 'utf8');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-worker-preflight-before-claim-'));
const dbPath = path.join(tempDir, 'ig_automation.db');
const db = new Database(dbPath);

db.exec(schema);

db.prepare(`INSERT INTO candidates(post_url, source) VALUES (?, 'test')`).run('https://www.instagram.com/p/preflight-queued/');
db.prepare(`
  INSERT INTO like_jobs(candidate_id, status, created_at, updated_at)
  VALUES (1, 'queued', datetime('now'), datetime('now'))
`).run();
db.prepare(`UPDATE system_flags SET value='true', updated_at=datetime('now') WHERE key='AUTOMATION_ENABLED'`).run();

const before = db.prepare(`
  SELECT id, status, attempt_count, started_at, finished_at, error_code, error_message
  FROM like_jobs
  WHERE id = 1
`).get();

let launchCalls = 0;
await run({
  db,
  chromiumImpl: {},
  browserSessionLauncher: async () => {
    launchCalls += 1;
    const err = new Error('simulated login wall');
    err.code = 'BROWSER_SESSION_NOT_READY';
    err.reason = 'SIMULATED_PREFLIGHT_FAILURE';
    throw err;
  },
  profileDir: path.join(tempDir, '.browser-profile')
});

assert.equal(launchCalls, 1, 'worker should attempt browser preflight exactly once');

const after = db.prepare(`
  SELECT id, status, attempt_count, started_at, finished_at, error_code, error_message
  FROM like_jobs
  WHERE id = 1
`).get();
assert.deepEqual(after, before, 'queued job should remain untouched when preflight fails before claim');

const pauseEvent = db.prepare(`
  SELECT event_type, payload_json
  FROM run_events
  WHERE event_type = 'automation_paused'
  ORDER BY id DESC
  LIMIT 1
`).get();
assert.equal(pauseEvent?.event_type, 'automation_paused', 'preflight failure should pause automation');
assert.match(pauseEvent?.payload_json || '', /browser_session_preflight_failed/, 'pause reason should reflect preflight failure');

const startedEvents = db.prepare(`SELECT COUNT(*) AS count FROM run_events WHERE event_type = 'job_started'`).get().count;
assert.equal(startedEvents, 0, 'worker must not emit job_started before a successful preflight');

const automationFlag = db.prepare(`SELECT value FROM system_flags WHERE key='AUTOMATION_ENABLED'`).get()?.value;
assert.equal(String(automationFlag).toLowerCase(), 'false', 'automation should be paused after preflight failure');

db.close();
fs.rmSync(tempDir, { recursive: true, force: true });
console.log('Worker preflight-before-claim validation passed');
