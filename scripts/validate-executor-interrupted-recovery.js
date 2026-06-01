import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { recoverInterruptedRunningJobs } from '../core/executor-runtime.js';

const schema = fs.readFileSync(path.resolve('db/schema.sql'), 'utf8');
const db = new Database(':memory:');
db.exec(schema);
db.prepare(`INSERT INTO candidates(post_url, source) VALUES ('https://instagram.com/p/interrupted', 'test')`).run();
db.prepare(`INSERT INTO like_jobs(candidate_id, status, started_at, updated_at) VALUES (1, 'running', datetime('now','-5 minutes'), datetime('now','-5 minutes'))`).run();

const result = recoverInterruptedRunningJobs(db, { actor: 'test', reason: 'validation' });
assert.equal(result.recovered, 1);
const row = db.prepare(`SELECT status, error_code FROM like_jobs WHERE id=1`).get();
assert.equal(row.status, 'stopped');
assert.equal(row.error_code, 'EXECUTOR_INTERRUPTED');

console.log('Executor interrupted recovery validation passed');
