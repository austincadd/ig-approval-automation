import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { readAccountSessionState, recordSessionChallenge } from '../core/session-state.js';
import { acknowledgeSessionChallenge, acknowledgeSessionRecovery, markSessionRevalidated } from '../core/session-recovery.js';

const schema = fs.readFileSync(path.resolve('db/schema.sql'), 'utf8');
const db = new Database(':memory:');
db.exec(schema);
recordSessionChallenge(db, { observedAt: '2026-06-01T13:00:00.000Z', reason: 'CHECKPOINT_DETECTED' });

acknowledgeSessionChallenge(db, { observedAt: '2026-06-01T13:05:00.000Z', reason: 'operator_seen' });
let state = readAccountSessionState(db);
assert.equal(state.trustState, 'pending_revalidation');
assert.equal(state.challengeAcknowledgedAt, '2026-06-01T13:05:00.000Z');

acknowledgeSessionRecovery(db, { observedAt: '2026-06-01T13:10:00.000Z', reason: 'login_completed' });
state = readAccountSessionState(db);
assert.equal(state.recoveryAcknowledgedAt, '2026-06-01T13:10:00.000Z');
assert.equal(state.quarantineState, 'quarantined');

markSessionRevalidated(db, { observedAt: '2026-06-01T13:12:00.000Z', reason: 'fresh_canary_ok' });
state = readAccountSessionState(db);
assert.equal(state.trustState, 'trusted');
assert.equal(state.revalidatedAt, '2026-06-01T13:12:00.000Z');
assert.equal(state.quarantineState, 'clear');
assert.equal(state.sessionHealth, 'ok');

console.log('Session recovery validation passed');
