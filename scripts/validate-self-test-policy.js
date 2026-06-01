import assert from 'node:assert/strict';
import { evaluateSelfTestSeverity } from '../core/self-test-policy.js';

const now = new Date('2026-06-01T13:00:00.000Z');
const results = [
  { testKey: 'control_plane_http', status: 'ok', checkedAt: '2026-06-01T12:30:00.000Z' },
  { testKey: 'db_integrity', status: 'ok', checkedAt: '2026-06-01T12:59:00.000Z' },
  { testKey: 'instagram_page_shape_probe', status: 'skipped', checkedAt: '2026-06-01T10:00:00.000Z' }
];
const evaluation = evaluateSelfTestSeverity(results, { now });
assert.ok(evaluation.blockingIssues.some((issue) => issue.testKey === 'control_plane_http' && issue.reason === 'stale'));
assert.ok(evaluation.warningIssues.some((issue) => issue.testKey === 'instagram_page_shape_probe' && issue.reason === 'stale'));

const degraded = evaluateSelfTestSeverity([
  { testKey: 'telegram_transport', status: 'degraded', checkedAt: '2026-06-01T12:59:00.000Z' }
], { now });
assert.ok(degraded.warningIssues.some((issue) => issue.testKey === 'telegram_transport'));

console.log('Self-test policy validation passed');
