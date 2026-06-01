import assert from 'node:assert/strict';
import { evaluateSessionTrust } from '../core/session-trust.js';

const trusted = evaluateSessionTrust({
  sessionState: {
    sessionHealth: 'ok',
    quarantineState: 'clear',
    trustState: 'trusted',
    lastLoginConfirmedAt: '2026-06-01T12:30:00.000Z',
    lastSuccessfulActionAt: '2026-06-01T12:40:00.000Z'
  },
  health: { canary: { ok: true, startedAt: '2026-06-01T12:50:00.000Z' } }
}, { now: '2026-06-01T13:00:00.000Z' });
assert.equal(trusted.ok, true);
assert.equal(trusted.state, 'trusted');

const challenged = evaluateSessionTrust({
  sessionState: { sessionHealth: 'challenge', quarantineState: 'quarantined', trustState: 'untrusted' },
  health: { canary: { ok: false, startedAt: '2026-06-01T12:50:00.000Z' } }
}, { now: '2026-06-01T13:00:00.000Z' });
assert.equal(challenged.ok, false);
assert.equal(challenged.state, 'unsafe');

const stale = evaluateSessionTrust({
  sessionState: {
    sessionHealth: 'ok',
    quarantineState: 'clear',
    trustState: 'trusted',
    lastLoginConfirmedAt: '2026-05-30T12:30:00.000Z',
    lastSuccessfulActionAt: '2026-05-30T12:40:00.000Z'
  },
  health: { canary: { ok: true, startedAt: '2026-05-30T12:50:00.000Z' } }
}, { now: '2026-06-01T13:00:00.000Z' });
assert.equal(stale.ok, false);
assert.equal(stale.state, 'degraded');

const pending = evaluateSessionTrust({
  sessionState: {
    sessionHealth: 'degraded',
    quarantineState: 'quarantined',
    trustState: 'pending_revalidation',
    lastLoginConfirmedAt: '2026-06-01T12:30:00.000Z',
    lastSuccessfulActionAt: '2026-06-01T12:40:00.000Z'
  },
  health: { canary: { ok: true, startedAt: '2026-06-01T12:50:00.000Z' } }
}, { now: '2026-06-01T13:00:00.000Z' });
assert.equal(pending.ok, false);
assert.equal(pending.state, 'blocked');

console.log('Session trust validation passed');
