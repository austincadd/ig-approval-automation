import assert from 'node:assert/strict';
import { evaluateReadiness } from '../core/readiness.js';

const baseStatus = {
  health: {
    controlPlane: 'ok',
    delivery: 'ok',
    executor: 'ready',
    account: 'ok',
    queue: 'backlog_present',
    canary: { ok: true, startedAt: '2026-06-01T12:55:00.000Z', state: 'healthy' }
  },
  incidents: { summary: { hasCritical: false }, active: [] },
  selfTests: { results: [
    { testKey: 'control_plane_http', status: 'ok', checkedAt: '2026-06-01T12:59:00.000Z' },
    { testKey: 'db_integrity', status: 'ok', checkedAt: '2026-06-01T12:59:00.000Z' },
    { testKey: 'session_canary_readonly', status: 'ok', checkedAt: '2026-06-01T12:59:00.000Z' }
  ] },
  sessionState: {
    sessionHealth: 'ok',
    quarantineState: 'clear',
    trustState: 'trusted',
    lastLoginConfirmedAt: '2026-06-01T12:30:00.000Z',
    lastSuccessfulActionAt: '2026-06-01T12:40:00.000Z'
  }
};

const ready = evaluateReadiness(null, baseStatus, { now: '2026-06-01T13:00:00.000Z' });
assert.equal(ready.ok, true);
assert.equal(ready.state, 'ready');

const challenge = evaluateReadiness(null, { ...baseStatus, health: { ...baseStatus.health, account: 'challenge' }, sessionState: { ...baseStatus.sessionState, sessionHealth: 'challenge', quarantineState: 'quarantined' } }, { now: '2026-06-01T13:00:00.000Z' });
assert.equal(challenge.ok, false);
assert.equal(challenge.state, 'unsafe');

const criticalIncident = evaluateReadiness(null, { ...baseStatus, incidents: { summary: { hasCritical: true }, active: [{ severity: 'critical' }] } }, { now: '2026-06-01T13:00:00.000Z' });
assert.equal(criticalIncident.ok, false);
assert.equal(criticalIncident.state, 'blocked');

console.log('Readiness validation passed');
