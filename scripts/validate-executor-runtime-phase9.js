import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { acquireExecutorOwner, evaluateExecutorOwner, reclaimExecutorOwner } from '../core/executor-ownership.js';
import { getOperatorAutomationStatus } from '../core/automation-status.js';

const schema = fs.readFileSync(path.resolve('db/schema.sql'), 'utf8');
const db = new Database(':memory:');
db.exec(schema);

acquireExecutorOwner(db, {
  ownerKey: 'browser-profile',
  mode: 'worker-loop',
  pid: 999999,
  profileDir: '.browser-profile',
  observedAt: '2026-06-01T10:00:00.000Z'
});

const stale = evaluateExecutorOwner(db, { ownerKey: 'browser-profile', staleAfterMs: 0 });
assert.equal(stale.reclaimable, true);
const reclaimed = reclaimExecutorOwner(db, { ownerKey: 'browser-profile', staleAfterMs: 0, observedAt: '2026-06-01T10:05:00.000Z' });
assert.equal(reclaimed.ok, true);

const status = getOperatorAutomationStatus(db);
assert.ok(status.executorOwner);
assert.equal(status.executorOwner.owner.state, 'reclaimed');

console.log('Phase 9 executor runtime validation passed');
