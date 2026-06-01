import { evaluateSelfTestSeverity } from './self-test-policy.js';
import { evaluateSessionTrust } from './session-trust.js';

function issue(code, summary, details = {}) {
  return { code, summary, details };
}

export function getReadinessBlockers(status, options = {}) {
  const blockers = [];
  const warnings = [];
  const selfTestEvaluation = evaluateSelfTestSeverity(status.selfTests?.results || [], options);
  const sessionTrust = evaluateSessionTrust(status, options);

  if (status.health?.controlPlane === 'stale' || status.health?.controlPlane === 'degraded') {
    blockers.push(issue('CONTROL_PLANE_UNHEALTHY', 'Control plane is not healthy.', { controlPlane: status.health?.controlPlane }));
  }

  if (status.health?.account === 'challenge') {
    blockers.push(issue('ACCOUNT_CHALLENGE', 'Instagram account challenge is active.', { account: status.health?.account }));
  }

  if (status.health?.account === 'logged_out') {
    blockers.push(issue('ACCOUNT_LOGGED_OUT', 'Instagram account is logged out.', { account: status.health?.account }));
  }

  if (status.incidents?.summary?.hasCritical) {
    blockers.push(issue('CRITICAL_INCIDENT_OPEN', 'One or more critical incidents are open.', { incidents: status.incidents?.summary }));
  }

  if (status.health?.canary?.state === 'operator_required' || status.health?.canary?.state === 'unsafe') {
    blockers.push(issue('CANARY_UNSAFE', status.health?.canary?.code || 'Canary reported unsafe/operator_required.', { canary: status.health?.canary }));
  }

  if (status.sessionState?.quarantineState && status.sessionState.quarantineState !== 'clear') {
    blockers.push(issue('SESSION_QUARANTINED', 'Session is quarantined.', { quarantineState: status.sessionState.quarantineState }));
  }

  for (const problem of selfTestEvaluation.blockingIssues) {
    blockers.push(issue(`SELF_TEST_${problem.reason.toUpperCase()}`, problem.summary, problem));
  }
  for (const problem of selfTestEvaluation.warningIssues) {
    warnings.push(issue(`SELF_TEST_${problem.reason.toUpperCase()}`, problem.summary, problem));
  }

  if (!sessionTrust.ok) {
    const target = sessionTrust.state === 'degraded' ? warnings : blockers;
    for (const reason of sessionTrust.reasons) {
      target.push(issue(reason.code, reason.summary, { trustState: sessionTrust.state, freshness: sessionTrust.freshness }));
    }
  }

  if (status.health?.delivery && status.health.delivery !== 'ok' && status.health.delivery !== 'fatal') {
    warnings.push(issue('DELIVERY_DEGRADED', 'Telegram delivery is degraded.', { delivery: status.health.delivery }));
  }

  if ((status.selfTests?.results || []).filter((row) => row.status === 'skipped').length > 0) {
    warnings.push(issue('OPTIONAL_TESTS_SKIPPED', 'One or more optional tests were skipped.', {}));
  }

  if (status.incidents?.active?.some((incident) => incident.severity !== 'critical')) {
    warnings.push(issue('NON_CRITICAL_INCIDENTS_OPEN', 'Non-critical incidents are open.', { incidents: status.incidents.summary }));
  }

  return { blockers, warnings, selfTestEvaluation, sessionTrust };
}

export function evaluateReadiness(db, status, options = {}) {
  const evaluatedAt = new Date().toISOString();
  const { blockers, warnings, selfTestEvaluation, sessionTrust } = getReadinessBlockers(status, options);
  let state = 'ready';
  if (blockers.length) state = blockers.some((item) => /UNSAFE|CHALLENGE/.test(item.code)) ? 'unsafe' : 'blocked';
  else if (warnings.length) state = 'degraded';

  return {
    ok: blockers.length === 0,
    state,
    blockingReasons: blockers,
    warnings,
    evaluatedAt,
    freshness: {
      selfTestsFresh: selfTestEvaluation.freshness.blockingFresh,
      canaryFresh: sessionTrust.freshness.canaryFresh,
      sessionFresh: sessionTrust.freshness.loginFresh
    },
    inputs: {
      controlPlane: status.health?.controlPlane,
      delivery: status.health?.delivery,
      executor: status.health?.executor,
      account: status.health?.account,
      queue: status.health?.queue,
      selfTests: status.selfTests,
      incidents: status.incidents,
      canary: status.health?.canary,
      sessionTrust
    }
  };
}

export function formatReadiness(readiness) {
  const blockers = readiness.blockingReasons.map((item) => item.code).join(', ') || 'none';
  const warnings = readiness.warnings.map((item) => item.code).join(', ') || 'none';
  return `Readiness: ${readiness.state} | blockers=${blockers} | warnings=${warnings}`;
}
