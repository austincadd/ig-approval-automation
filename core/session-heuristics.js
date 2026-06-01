function parseTimestamp(value) {
  if (!value) return null;
  const normalized = String(value).includes('T') ? String(value) : String(value).replace(' ', 'T');
  const date = new Date(normalized.endsWith('Z') ? normalized : `${normalized}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function ageHours(value, now = new Date()) {
  const date = parseTimestamp(value);
  if (!date) return null;
  return (now.getTime() - date.getTime()) / 3600000;
}

export function evaluateSessionHeuristics(status, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const session = status.sessionState || {};
  const issues = [];

  const loginAgeHours = ageHours(session.lastLoginConfirmedAt, now);
  const actionAgeHours = ageHours(session.lastSuccessfulActionAt, now);
  const challengeAgeHours = ageHours(session.lastChallengeAt, now);

  if (loginAgeHours != null && loginAgeHours > (options.loginWarningHours ?? 24)) {
    issues.push({ code: 'LOGIN_AGE_HIGH', summary: `Login confirmation is ${loginAgeHours.toFixed(1)}h old.` });
  }
  if (actionAgeHours != null && actionAgeHours > (options.actionWarningHours ?? 24)) {
    issues.push({ code: 'ACTION_AGE_HIGH', summary: `Last successful action is ${actionAgeHours.toFixed(1)}h old.` });
  }
  if (challengeAgeHours != null && challengeAgeHours < (options.recentChallengeHours ?? 24)) {
    issues.push({ code: 'RECENT_CHALLENGE', summary: `Challenge occurred ${challengeAgeHours.toFixed(1)}h ago.` });
  }
  if (session.trustState === 'pending_revalidation') {
    issues.push({ code: 'PENDING_REVALIDATION', summary: 'Session recovery was acknowledged but not yet revalidated.' });
  }

  return {
    loginAgeHours,
    actionAgeHours,
    challengeAgeHours,
    issues,
    elevatedRisk: issues.length > 0
  };
}
