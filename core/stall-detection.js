function asDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function ageMinutes(value, now = new Date()) {
  const date = asDate(value);
  if (!date) return null;
  return (now.getTime() - date.getTime()) / 60000;
}

function latestTimestamp(...values) {
  const dates = values.map(asDate).filter(Boolean);
  if (!dates.length) return null;
  return new Date(Math.max(...dates.map((date) => date.getTime())));
}

function isFresh(value, thresholdMinutes, now) {
  const age = ageMinutes(value, now);
  return age !== null && age <= thresholdMinutes;
}

function buildIncident(summary, severity, details) {
  return {
    kind: 'queue_stalled',
    severity,
    dedupeKey: 'queue_stalled',
    summary,
    details
  };
}

export function detectQueueStall(status, options = {}) {
  const now = asDate(options.now) || new Date();
  const queueStallMinutes = Number(options.queueStallMinutes ?? 15);
  const workerStaleMinutes = Number(options.workerStaleMinutes ?? 10);
  const progressStaleMinutes = Number(options.progressStaleMinutes ?? 10);
  const queued = Number(status?.counts?.queued || 0);

  if (queued <= 0) {
    return { ok: true, stalled: false, incident: null };
  }

  const workerAlive = status?.worker?.alive !== false;
  const lastRunningUpdateAt = latestTimestamp(status?.worker?.lastRunningUpdateAt, status?.worker?.activeJob?.updatedAt);
  const lastProgressAt = latestTimestamp(lastRunningUpdateAt, status?.worker?.lastFinishedAt, status?.worker?.lastSuccessAt);
  const lastSuccessAgeMinutes = ageMinutes(status?.worker?.lastSuccessAt, now);
  const progressAgeMinutes = ageMinutes(lastProgressAt, now);
  const workerSeenAgeMinutes = ageMinutes(status?.worker?.lastFinishedAt || status?.worker?.lastStartedAt || lastRunningUpdateAt, now);
  const hasFreshActiveProgress = isFresh(lastRunningUpdateAt, progressStaleMinutes, now);
  const hasFreshAnyProgress = isFresh(lastProgressAt, progressStaleMinutes, now);

  if (!workerAlive) {
    return {
      ok: false,
      stalled: true,
      incident: buildIncident(
        `Queue stalled: ${queued} queued job(s) but worker is not alive.`,
        'critical',
        {
          reason: 'worker_not_alive',
          queued,
          workerHealth: status?.worker?.health || null,
          workerSeenAgeMinutes,
          workerStaleMinutes
        }
      )
    };
  }

  if (!hasFreshActiveProgress && progressAgeMinutes !== null && progressAgeMinutes > progressStaleMinutes) {
    return {
      ok: false,
      stalled: true,
      incident: buildIncident(
        `Queue stalled: ${queued} queued job(s) with no active progress for ${Math.floor(progressAgeMinutes)} minute(s).`,
        'warn',
        {
          reason: 'active_progress_stale',
          queued,
          progressAgeMinutes,
          progressStaleMinutes,
          lastProgressAt: lastProgressAt?.toISOString() || null,
          lastRunningUpdateAt: lastRunningUpdateAt?.toISOString() || null,
          hasActiveJob: !!status?.worker?.activeJob
        }
      )
    };
  }

  if (!hasFreshAnyProgress && lastSuccessAgeMinutes !== null && lastSuccessAgeMinutes > queueStallMinutes) {
    return {
      ok: false,
      stalled: true,
      incident: buildIncident(
        `Queue stalled: ${queued} queued job(s), last success ${Math.floor(lastSuccessAgeMinutes)} minute(s) ago, and no recent useful progress.`,
        'warn',
        {
          reason: 'last_success_too_old',
          queued,
          lastSuccessAgeMinutes,
          queueStallMinutes,
          progressAgeMinutes,
          lastSuccessAt: status?.worker?.lastSuccessAt || null,
          lastProgressAt: lastProgressAt?.toISOString() || null
        }
      )
    };
  }

  return { ok: true, stalled: false, incident: null };
}
