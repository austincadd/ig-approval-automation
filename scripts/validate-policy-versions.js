import assert from 'node:assert/strict';
import { getPolicyVersions, getPolicyVersionSummary } from '../core/policy-versions.js';

const versions = getPolicyVersions();
assert.deepEqual(Object.keys(versions).sort(), [
  'canaryPolicyVersion',
  'failurePolicyVersion',
  'retryPolicyVersion',
  'schemaVersion',
  'selectorStrategyVersion',
  'suppressionPolicyVersion'
].sort());
for (const value of Object.values(versions)) {
  assert.equal(typeof value, 'string');
  assert.ok(value.length > 0);
}
assert.match(getPolicyVersionSummary(), /selectors=/);
assert.match(getPolicyVersionSummary(), /failure=/);
console.log('Policy version validation passed');
