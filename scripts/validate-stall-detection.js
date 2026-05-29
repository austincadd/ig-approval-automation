import assert from 'node:assert/strict';
import { detectQueueStall } from '../core/stall-detection.js';

const now = '2026-05-29T12:00:00Z';

const deadWorker = detectQueueStall({
  counts: { queued: 3 },
  worker: {
    alive: false,
    health: 'not_running',
    lastFinishedAt: '2026-05-29T11:30:00Z',
    lastStartedAt: '2026-05-29T11:20:00Z'
  }
}, { now });
assert.equal(deadWorker.stalled, true);
assert.equal(deadWorker.incident.severity, 'critical');
assert.equal(deadWorker.incident.details.reason, 'worker_not_alive');

const staleProgress = detectQueueStall({
  counts: { queued: 2 },
  worker: {
    alive: true,
    health: 'running',
    activeJob: { updatedAt: '2026-05-29T11:40:00Z' },
    lastRunningUpdateAt: '2026-05-29T11:40:00Z',
    lastFinishedAt: '2026-05-29T11:35:00Z',
    lastSuccessAt: '2026-05-29T11:30:00Z'
  }
}, { now, progressStaleMinutes: 10 });
assert.equal(staleProgress.stalled, true);
assert.equal(staleProgress.incident.details.reason, 'active_progress_stale');

const noQueue = detectQueueStall({
  counts: { queued: 0 },
  worker: { alive: false }
}, { now });
assert.equal(noQueue.stalled, false);
assert.equal(noQueue.ok, true);

const healthy = detectQueueStall({
  counts: { queued: 4 },
  worker: {
    alive: true,
    health: 'running',
    activeJob: { updatedAt: '2026-05-29T11:58:00Z' },
    lastRunningUpdateAt: '2026-05-29T11:58:00Z',
    lastFinishedAt: '2026-05-29T11:57:00Z',
    lastSuccessAt: '2026-05-29T11:57:00Z'
  }
}, { now, progressStaleMinutes: 10, queueStallMinutes: 15 });
assert.equal(healthy.stalled, false);
assert.equal(healthy.incident, null);

console.log('Stall detection validation passed');
