import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { runSyntheticChecks } from '../core/synthetic-checks.js';

const schema = fs.readFileSync(path.resolve('db/schema.sql'), 'utf8');
const db = new Database(':memory:');
db.exec(schema);

const result = runSyntheticChecks(db);
assert.equal(result.results.length, 3);
assert.ok(result.results.every((row) => row.status === 'ok'));
const stored = db.prepare(`SELECT COUNT(*) AS count FROM self_test_results WHERE test_key LIKE 'synthetic_%'`).get().count;
assert.equal(stored, 3);

console.log('Synthetic checks validation passed');
