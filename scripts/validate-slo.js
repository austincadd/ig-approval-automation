import assert from 'node:assert/strict';
import { evaluateSlo } from '../core/slo-policy.js';

const good = evaluateSlo({}, {
  summary: {
    successRate: 0.95,
    criticalIncidents: 0,
    autoRecoveryFailures: 0,
    operatorRequiredIncidents: 0,
    maxQueuedAgeMinutes: 5,
    degradedMinutes: 5,
    controlPlaneStaleMinutes: 0
  },
  byPageShape: [{ pageShape: 'post', terminalCount: 10, successRate: 0.9 }]
});
assert.equal(good.state, 'within_slo');

const bad = evaluateSlo({}, {
  summary: {
    successRate: 0.5,
    criticalIncidents: 2,
    autoRecoveryFailures: 5,
    operatorRequiredIncidents: 3,
    maxQueuedAgeMinutes: 120,
    degradedMinutes: 90,
    controlPlaneStaleMinutes: 20
  },
  byPageShape: [{ pageShape: 'post', terminalCount: 10, successRate: 0.4 }]
});
assert.equal(bad.state, 'violated');
assert.ok(bad.violations.length >= 3);

console.log('SLO validation passed');
