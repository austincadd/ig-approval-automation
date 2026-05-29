const POLICY_VERSIONS = Object.freeze({
  schemaVersion: '2026-05-29.phase5',
  selectorStrategyVersion: 'v2.0',
  failurePolicyVersion: 'v2.0',
  retryPolicyVersion: 'v1.0',
  suppressionPolicyVersion: 'v1.0',
  canaryPolicyVersion: 'v2.0'
});

export function getPolicyVersions() {
  return { ...POLICY_VERSIONS };
}

export function getPolicyVersionSummary() {
  return `schema=${POLICY_VERSIONS.schemaVersion} selectors=${POLICY_VERSIONS.selectorStrategyVersion} failure=${POLICY_VERSIONS.failurePolicyVersion} retry=${POLICY_VERSIONS.retryPolicyVersion} suppression=${POLICY_VERSIONS.suppressionPolicyVersion} canary=${POLICY_VERSIONS.canaryPolicyVersion}`;
}
