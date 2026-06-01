import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { acquireExecutorOwner, heartbeatExecutorOwner, releaseExecutorOwner, evaluateExecutorOwner, reclaimExecutorOwner } from '../core/executor-ownership.js';

const schema = fs.readFileSync(path.resolve('db/schema.sql'), 'utf8');
const db = new Database(':memory:');
db.exec(schema);

const active = acquireExecutorOwner(db, {
  ownerKey: 'browser-profile',
  mode: 'worker-once',
  pid: process.pid,
  profileDir: '.browser-profile'
});
assert.equal(active.state, 'active');
assert.equal(active.mode, 'worker-once');

const heartbeated = heartbeatExecutorOwner(db, { ownerKey: 'browser-profile', details: { phase: 'test' } });
assert.equal(heartbeated.state, 'active');
assert.equal(heartbeated.details.phase, 'test');

const evaluated = evaluateExecutorOwner(db, { ownerKey: 'browser-profile', staleAfterMs: 999999 });
assert.equal(evaluated.state, 'active');
assert.equal(evaluated.reclaimable, false);

const released = releaseExecutorOwner(db, { ownerKey: 'browser-profile' });
assert.equal(released.state, 'released');

acquireExecutorOwner(db, {
  ownerKey: 'stale-owner',
  mode: 'worker-loop',
  pid: 999999,
  profileDir: '.browser-profile',
  observedAt: '2026-06-01T10:00:00.000Z'
});
const staleEval = evaluateExecutorOwner(db, { ownerKey: 'stale-owner', staleAfterMs: 0 });
assert.equal(staleEval.reclaimable, true);
const reclaimed = reclaimExecutorOwner(db, { ownerKey: 'stale-owner', staleAfterMs: 0, observedAt: '2026-06-01T10:10:00.000Z' });
assert.equal(reclaimed.ok, true);
assert.equal(reclaimed.owner.state, 'reclaimed');

console.log('Executor ownership validation passed');
