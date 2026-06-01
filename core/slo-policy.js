function ratio(numerator, denominator) {
  return denominator > 0 ? Number((numerator / denominator).toFixed(4)) : null;
}

export function getSloPolicy() {
  return {
    maxQueueAgeMinutes: 60,
    maxControlPlaneStaleMinutes: 15,
    maxDegradedDurationMinutes: 30,
    minSuccessRate: 0.85,
    minSuccessRateByPageShape: 0.75,
    maxAutoRecoveryFailuresPerWindow: 3,
    maxOperatorRequiredIncidentsPerWindow: 2,
    maxCriticalIncidentsPerWindow: 1
  };
}

export function evaluateSlo(status, soakReport, options = {}) {
  const policy = options.policy || getSloPolicy();
  const summary = soakReport.summary || {};
  const byPageShape = soakReport.byPageShape || [];
  const checks = [];

  const push = (key, pass, actual, target, severity = 'warn') => checks.push({ key, pass, actual, target, severity });

  push('success_rate', (summary.successRate ?? 1) >= policy.minSuccessRate, summary.successRate, policy.minSuccessRate, 'critical');
  push('critical_incidents', (summary.criticalIncidents ?? 0) <= policy.maxCriticalIncidentsPerWindow, summary.criticalIncidents, policy.maxCriticalIncidentsPerWindow, 'critical');
  push('auto_recovery_failures', (summary.autoRecoveryFailures ?? 0) <= policy.maxAutoRecoveryFailuresPerWindow, summary.autoRecoveryFailures, policy.maxAutoRecoveryFailuresPerWindow, 'warn');
  push('operator_required_incidents', (summary.operatorRequiredIncidents ?? 0) <= policy.maxOperatorRequiredIncidentsPerWindow, summary.operatorRequiredIncidents, policy.maxOperatorRequiredIncidentsPerWindow, 'warn');
  push('queue_age_minutes', (summary.maxQueuedAgeMinutes ?? 0) <= policy.maxQueueAgeMinutes, summary.maxQueuedAgeMinutes, policy.maxQueueAgeMinutes, 'critical');
  push('degraded_minutes', (summary.degradedMinutes ?? 0) <= policy.maxDegradedDurationMinutes, summary.degradedMinutes, policy.maxDegradedDurationMinutes, 'warn');
  push('control_plane_stale_minutes', (summary.controlPlaneStaleMinutes ?? 0) <= policy.maxControlPlaneStaleMinutes, summary.controlPlaneStaleMinutes, policy.maxControlPlaneStaleMinutes, 'critical');

  for (const row of byPageShape) {
    if (row.terminalCount > 0) {
      push(`page_shape:${row.pageShape}`, (row.successRate ?? 1) >= policy.minSuccessRateByPageShape, row.successRate, policy.minSuccessRateByPageShape, 'warn');
    }
  }

  const violations = checks.filter((check) => !check.pass);
  const criticalViolations = violations.filter((check) => check.severity === 'critical');
  return {
    policy,
    checks,
    violations,
    state: criticalViolations.length ? 'violated' : (violations.length ? 'warning' : 'within_slo')
  };
}

export { ratio };
