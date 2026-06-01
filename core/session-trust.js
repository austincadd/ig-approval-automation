import { evaluateSessionHeuristics } from './session-heuristics.js';

function parseTimestamp(value) {
  if (!value) return null;
  const normalized = String(value).includes('T') ? String(value) : String(value).replace(' ', 'T');
  const date = new Date(normalized.endsWith('Z') ? normalized : `${normalized}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isFresh(value, maxAgeMs, now = new Date()) {
  const date = parseTimestamp(value);
  if (!date) return false;
  return (now.getTime() - date.getTime()) <= maxAgeMs;
}

export function evaluateSessionTrust(status, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const canaryFreshMs = options.canaryFreshnessMs ?? 15 * 60 * 1000;
  const loginFreshMs = options.loginFreshnessMs ?? 24 * 60 * 60 * 1000;
  const actionFreshMs = options.successfulActionFreshnessMs ?? 24 * 60 * 60 * 1000;
  const sessionState = status.sessionState || {};
  const canary = status.health?.canary || null;
  const reasons = [];

  const freshness = {
    canaryFresh: isFresh(canary?.startedAt, canaryFreshMs, now),
    loginFresh: isFresh(sessionState.lastLoginConfirmedAt, loginFreshMs, now),
    lastSuccessfulActionFresh: isFresh(sessionState.lastSuccessfulActionAt, actionFreshMs, now)
  };

  const heuristics = evaluateSessionHeuristics(status, { now, ...options });

  if (sessionState.sessionHealth === 'challenge') {
    reasons.push({ code: 'SESSION_CHALLENGE', summary: 'Account challenge is active.' });
    return { ok: false, state: 'unsafe', reasons, freshness, heuristics };
  }

  if (sessionState.sessionHealth === 'logged_out') {
    reasons.push({ code: 'SESSION_LOGGED_OUT', summary: 'Account is logged out.' });
    return { ok: false, state: 'blocked', reasons, freshness, heuristics };
  }

  if (sessionState.trustState === 'pending_revalidation') {
    reasons.push({ code: 'SESSION_PENDING_REVALIDATION', summary: 'Session recovery was acknowledged and is awaiting revalidation.' });
  }

  if (sessionState.quarantineState && sessionState.quarantineState !== 'clear') {
    reasons.push({ code: 'SESSION_QUARANTINED', summary: 'Session is quarantined.' });
  }

  if (!freshness.canaryFresh) {
    reasons.push({ code: 'CANARY_STALE', summary: 'Canary signal is stale.' });
  }

  if (!freshness.loginFresh) {
    reasons.push({ code: 'LOGIN_CONFIRMATION_STALE', summary: 'Login confirmation is stale.' });
  }

  if (!freshness.lastSuccessfulActionFresh) {
    reasons.push({ code: 'LAST_ACTION_STALE', summary: 'Last successful action is stale.' });
  }

  if (canary?.ok === false && (canary?.state === 'operator_required' || canary?.state === 'unsafe')) {
    reasons.push({ code: 'CANARY_UNSAFE', summary: canary.code || 'Canary indicates unsafe state.' });
    return { ok: false, state: 'unsafe', reasons, freshness, heuristics };
  }

  for (const issue of heuristics.issues) reasons.push(issue);

  if (sessionState.quarantineState && sessionState.quarantineState !== 'clear') {
    return { ok: false, state: 'blocked', reasons, freshness, heuristics };
  }

  if (sessionState.trustState === 'pending_revalidation') {
    return { ok: false, state: 'blocked', reasons, freshness, heuristics };
  }

  if (reasons.some((reason) => reason.code === 'CANARY_STALE' || reason.code === 'LOGIN_CONFIRMATION_STALE' || reason.code === 'LOGIN_AGE_HIGH' || reason.code === 'ACTION_AGE_HIGH' || reason.code === 'RECENT_CHALLENGE')) {
    return { ok: false, state: 'degraded', reasons, freshness, heuristics };
  }

  return { ok: true, state: 'trusted', reasons, freshness, heuristics };
}
