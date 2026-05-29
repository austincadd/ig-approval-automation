import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  readAccountSessionState,
  recordSessionChallenge,
  recordSessionLoginConfirmed,
  recordSessionLogout,
  recordSuccessfulAction,
  setSessionQuarantine
} from '../core/session-state.js';

const schema = fs.readFileSync(path.resolve('db/schema.sql'), 'utf8');
const db = new Database(':memory:');
db.exec(schema);

let state = readAccountSessionState(db);
assert.equal(state.sessionHealth, 'unknown');
assert.equal(state.quarantineState, 'clear');

state = recordSessionLoginConfirmed(db, { observedAt: '2026-05-28T12:00:00.000Z', metadata: { source: 'canary' } });
assert.equal(state.sessionHealth, 'ok');
assert.equal(state.lastLoginConfirmedAt, '2026-05-28T12:00:00.000Z');
assert.equal(state.quarantineState, 'clear');

state = recordSuccessfulAction(db, { observedAt: '2026-05-28T12:05:00.000Z', metadata: { jobId: 7 } });
assert.equal(state.lastSuccessfulActionAt, '2026-05-28T12:05:00.000Z');
assert.equal(state.sessionHealth, 'ok');

state = recordSessionChallenge(db, { observedAt: '2026-05-28T12:10:00.000Z', reason: 'CHECKPOINT_DETECTED' });
assert.equal(state.sessionHealth, 'challenge');
assert.equal(state.lastChallengeAt, '2026-05-28T12:10:00.000Z');
assert.equal(state.quarantineState, 'quarantined');

state = recordSessionLogout(db, { observedAt: '2026-05-28T12:15:00.000Z', reason: 'CANARY_NOT_LOGGED_IN' });
assert.equal(state.sessionHealth, 'logged_out');
assert.equal(state.quarantineState, 'quarantined');

state = setSessionQuarantine(db, { observedAt: '2026-05-28T12:16:00.000Z', reason: 'manual_hold', sessionHealth: 'degraded' });
assert.equal(state.sessionHealth, 'degraded');
assert.equal(state.quarantineReason, 'manual_hold');

console.log('Session state validation passed');
