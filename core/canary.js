import { waitForPrimaryActionControlWithRetry } from '../worker/selectors.js';
import { detectChallengeFromSignals, CHALLENGE_SELECTORS } from '../worker/safety.js';
import { recordSessionChallenge, recordSessionLoginConfirmed, recordSessionLogout, setSessionQuarantine } from './session-state.js';
import { getPolicyVersions } from './policy-versions.js';

async function getVisiblePageText(page) {
  return page.evaluate(() => document.body?.innerText || '').catch(() => '');
}

async function getChallengeSelectorHits(page) {
  const hits = [];
  for (const selector of CHALLENGE_SELECTORS) {
    const count = await page.locator(selector).count().catch(() => 0);
    if (count > 0) hits.push(selector);
  }
  return hits;
}

async function detectChallenge(page) {
  const [visibleText, selectorHits] = await Promise.all([
    getVisiblePageText(page),
    getChallengeSelectorHits(page)
  ]);
  return detectChallengeFromSignals({ url: page.url(), visibleText, selectorHits });
}

function persistState(db, key, value) {
  db.prepare(`
    INSERT INTO system_flags(key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')
  `).run(key, JSON.stringify(value));
}

export async function runExecutorCanary({ db, page, profileUrl = 'https://www.instagram.com/' } = {}) {
  const startedAt = new Date().toISOString();
  const result = {
    startedAt,
    policyVersions: getPolicyVersions(),
    ok: false,
    state: 'degraded',
    code: null,
    reason: null,
    finalUrl: null,
    actionSurface: null,
    challenge: null
  };

  try {
    await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (error) {
    result.code = 'CANARY_PROFILE_LOAD_FAILED';
    result.reason = error?.message || 'profile_load_failed';
    result.finalUrl = page.url();
    persistState(db, 'EXECUTOR_CANARY_RESULT', result);
    setSessionQuarantine(db, { sessionHealth: 'degraded', reason: result.code, metadata: { reason: result.reason, finalUrl: result.finalUrl } });
    return result;
  }

  result.finalUrl = page.url();
  const challenge = await detectChallenge(page);
  result.challenge = challenge;
  if (challenge.blocked) {
    result.code = 'CANARY_CHALLENGE_DETECTED';
    result.reason = `${challenge.reason}${challenge.detail ? `:${challenge.detail}` : ''}`;
    result.state = 'operator_required';
    persistState(db, 'EXECUTOR_CANARY_RESULT', result);
    recordSessionChallenge(db, { reason: result.reason, metadata: { finalUrl: result.finalUrl, challenge } });
    return result;
  }

  const visibleText = (await getVisiblePageText(page)).toLowerCase();
  const loggedOut = visibleText.includes('log in') || visibleText.includes('login');
  if (loggedOut) {
    result.code = 'CANARY_NOT_LOGGED_IN';
    result.reason = 'login_markers_present';
    result.state = 'operator_required';
    persistState(db, 'EXECUTOR_CANARY_RESULT', result);
    recordSessionLogout(db, { reason: result.reason, metadata: { finalUrl: result.finalUrl } });
    return result;
  }

  const actionSurface = await waitForPrimaryActionControlWithRetry(page, { timeoutMs: 3000 });
  result.actionSurface = {
    ok: actionSurface.ok,
    state: actionSurface.state || 'unknown',
    diagnostics: actionSurface.diagnostics || null,
    attempts: actionSurface.attempts || 1
  };

  if (!actionSurface.ok) {
    result.code = 'CANARY_ACTION_SURFACE_MISSING';
    result.reason = 'primary_action_surface_not_detected';
    result.state = 'degraded';
    persistState(db, 'EXECUTOR_CANARY_RESULT', result);
    setSessionQuarantine(db, { sessionHealth: 'degraded', reason: result.code, metadata: { actionSurface: result.actionSurface, finalUrl: result.finalUrl } });
    return result;
  }

  result.ok = true;
  result.state = 'healthy';
  persistState(db, 'EXECUTOR_CANARY_RESULT', result);
  recordSessionLoginConfirmed(db, { metadata: { finalUrl: result.finalUrl, actionSurface: result.actionSurface } });
  return result;
}

export function readExecutorCanaryResult(db) {
  const raw = db.prepare(`SELECT value FROM system_flags WHERE key='EXECUTOR_CANARY_RESULT'`).get()?.value;
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
