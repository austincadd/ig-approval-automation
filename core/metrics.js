function safeParseJson(value) {
  try { return value ? JSON.parse(value) : {}; } catch { return {}; }
}

function ratio(successes, total) {
  return total > 0 ? Number((successes / total).toFixed(4)) : null;
}

export function getReliabilityMetrics(db, input = {}) {
  const days = Math.max(1, Math.trunc(Number(input.days) || 7));

  const daily = db.prepare(`
    SELECT substr(COALESCE(finished_at, updated_at, created_at), 1, 10) AS day,
           SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success_count,
           SUM(CASE WHEN status IN ('success', 'failed', 'blocked') THEN 1 ELSE 0 END) AS terminal_count,
           SUM(CASE WHEN error_code = 'LIKE_BUTTON_NOT_FOUND' THEN 1 ELSE 0 END) AS selector_failure_count,
           SUM(CASE WHEN error_code LIKE 'LIKE_%CONFIRMED' OR error_code = 'LIKE_VERIFICATION_AMBIGUOUS' THEN 1 ELSE 0 END) AS verification_failure_count,
           SUM(CASE WHEN error_code = 'CHECKPOINT_DETECTED' THEN 1 ELSE 0 END) AS challenge_count
    FROM like_jobs
    WHERE datetime(COALESCE(finished_at, updated_at, created_at)) >= datetime('now', ?)
    GROUP BY 1
    ORDER BY day DESC
  `).all(`-${days} days`).map((row) => ({
    day: row.day,
    successCount: row.success_count,
    terminalCount: row.terminal_count,
    successRate: ratio(row.success_count, row.terminal_count),
    selectorFailureCount: row.selector_failure_count,
    verificationFailureCount: row.verification_failure_count,
    challengeCount: row.challenge_count
  }));

  const byShape = db.prepare(`
    SELECT COALESCE(json_extract(re.payload_json, '$.pageShape'), 'unknown') AS page_shape,
           SUM(CASE WHEN re.event_type = 'job_success' THEN 1 ELSE 0 END) AS success_count,
           SUM(CASE WHEN re.event_type IN ('job_success', 'job_failed', 'job_blocked') THEN 1 ELSE 0 END) AS terminal_count
    FROM run_events re
    WHERE re.event_type IN ('job_success', 'job_failed', 'job_blocked')
      AND datetime(re.created_at) >= datetime('now', ?)
    GROUP BY 1
    ORDER BY terminal_count DESC, page_shape ASC
  `).all(`-${days} days`).map((row) => ({
    pageShape: row.page_shape,
    successCount: row.success_count,
    terminalCount: row.terminal_count,
    successRate: ratio(row.success_count, row.terminal_count)
  }));

  const summaryRow = db.prepare(`
    SELECT SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success_count,
           SUM(CASE WHEN status IN ('success', 'failed', 'blocked') THEN 1 ELSE 0 END) AS terminal_count,
           SUM(CASE WHEN error_code = 'LIKE_BUTTON_NOT_FOUND' THEN 1 ELSE 0 END) AS selector_failure_count,
           SUM(CASE WHEN error_code LIKE 'LIKE_%CONFIRMED' OR error_code = 'LIKE_VERIFICATION_AMBIGUOUS' THEN 1 ELSE 0 END) AS verification_failure_count,
           SUM(CASE WHEN error_code = 'CHECKPOINT_DETECTED' THEN 1 ELSE 0 END) AS challenge_count
    FROM like_jobs
    WHERE datetime(COALESCE(finished_at, updated_at, created_at)) >= datetime('now', ?)
  `).get(`-${days} days`);

  const transportEvents = db.prepare(`
    SELECT payload_json
    FROM run_events
    WHERE event_type = 'telegram_transport_health_changed'
      AND datetime(created_at) >= datetime('now', ?)
  `).all(`-${days} days`).map((row) => safeParseJson(row.payload_json));
  const transportDegradedCount = transportEvents.filter((event) => event.status && event.status !== 'ok').length;
  const transportTotalCount = transportEvents.length;

  const operatorIncidents = db.prepare(`
    SELECT created_at, event_type, payload_json
    FROM run_events
    WHERE event_type IN ('automation_paused', 'automation_resumed')
    ORDER BY datetime(created_at) ASC, id ASC
  `).all();

  const interventionMinutes = [];
  let openIncident = null;
  for (const row of operatorIncidents) {
    const payload = safeParseJson(row.payload_json);
    if (row.event_type === 'automation_paused' && payload?.actor === 'worker') {
      openIncident = row.created_at;
      continue;
    }
    if (row.event_type === 'automation_resumed' && payload?.actor && payload.actor !== 'worker' && openIncident) {
      const start = new Date(openIncident.replace(' ', 'T') + 'Z').getTime();
      const end = new Date(row.created_at.replace(' ', 'T') + 'Z').getTime();
      if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
        interventionMinutes.push((end - start) / 60000);
      }
      openIncident = null;
    }
  }

  return {
    windowDays: days,
    summary: {
      successCount: summaryRow?.success_count || 0,
      terminalCount: summaryRow?.terminal_count || 0,
      successRate: ratio(summaryRow?.success_count || 0, summaryRow?.terminal_count || 0),
      selectorFailureRate: ratio(summaryRow?.selector_failure_count || 0, summaryRow?.terminal_count || 0),
      verificationFailureRate: ratio(summaryRow?.verification_failure_count || 0, summaryRow?.terminal_count || 0),
      challengeIncidenceRate: ratio(summaryRow?.challenge_count || 0, summaryRow?.terminal_count || 0),
      telegramDeliveryDegradationRate: ratio(transportDegradedCount, transportTotalCount),
      meanTimeToOperatorInterventionMinutes: interventionMinutes.length
        ? Number((interventionMinutes.reduce((sum, value) => sum + value, 0) / interventionMinutes.length).toFixed(2))
        : null
    },
    byDay: daily,
    byPageShape: byShape
  };
}
