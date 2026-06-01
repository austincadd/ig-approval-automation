import assert from 'node:assert/strict';
import { evaluateSessionHeuristics } from '../core/session-heuristics.js';

const healthy = evaluateSessionHeuristics({
  sessionState: {
    lastLoginConfirmedAt: '2026-06-01T12:00:00.000Z',
    lastSuccessfulActionAt: '2026-06-01T12:30:00.000Z',
    lastChallengeAt: null,
    trustState: 'trusted'
  }
}, { now: '2026-06-01T13:00:00.000Z' });
assert.equal(healthy.elevatedRisk, false);

const risky = evaluateSessionHeuristics({
  sessionState: {
    lastLoginConfirmedAt: '2026-05-30T11:00:00.000Z',
    lastSuccessfulActionAt: '2026-05-30T10:00:00.000Z',
    lastChallengeAt: '2026-06-01T01:00:00.000Z',
    trustState: 'pending_revalidation'
  }
}, { now: '2026-06-01T13:00:00.000Z' });
assert.ok(risky.issues.some((issue) => issue.code === 'LOGIN_AGE_HIGH'));
assert.ok(risky.issues.some((issue) => issue.code === 'RECENT_CHALLENGE'));
assert.ok(risky.issues.some((issue) => issue.code === 'PENDING_REVALIDATION'));

console.log('Session heuristics validation passed');
