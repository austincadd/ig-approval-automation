import { buildIncidentNotification, recordIncidentNotification, shouldNotifyIncidentTransition, wasIncidentNotificationSent } from './escalation.js';
function safeJsonParse(value) {
  try {
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

function toSqliteDateTime(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 19).replace('T', ' ');
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function normalizeString(value, fallback = null) {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
}

function severityToLevel(severity) {
  if (severity === 'critical') return 'error';
  if (severity === 'warn') return 'warn';
  return 'info';
}

function serializeDetails(details) {
  if (details === undefined) return null;
  return JSON.stringify(details ?? null);
}

function mapIncidentRow(row) {
  if (!row) return null;
  return {
    incidentKey: row.incident_key,
    kind: row.kind,
    severity: row.severity,
    status: row.status,
    dedupeKey: row.dedupe_key,
    summary: row.summary,
    details: safeJsonParse(row.details_json),
    sourceEventId: row.source_event_id,
    autoRecoveryAttempts: row.auto_recovery_attempts,
    lastRecoveryAttemptAt: row.last_recovery_attempt_at,
    startedAt: row.started_at,
    lastSeenAt: row.last_seen_at,
    resolvedAt: row.resolved_at,
    updatedAt: row.updated_at
  };
}

function insertRunEvent(db, incident, eventType, payload = {}) {
  db.prepare(`
    INSERT INTO run_events(job_id, level, event_type, payload_json)
    VALUES (NULL, ?, ?, ?)
  `).run(severityToLevel(incident?.severity), eventType, JSON.stringify({
    incidentKey: incident?.incidentKey,
    kind: incident?.kind,
    severity: incident?.severity,
    status: incident?.status,
    dedupeKey: incident?.dedupeKey,
    summary: incident?.summary,
    sourceEventId: incident?.sourceEventId ?? null,
    ...payload
  }));
}

function findIncidentRow(db, { incidentKey = null, dedupeKey = null, kind = null, includeClosed = false } = {}) {
  const conditions = [];
  const params = [];

  if (incidentKey) {
    conditions.push('incident_key = ?');
    params.push(incidentKey);
  }
  if (dedupeKey) {
    conditions.push('dedupe_key = ?');
    params.push(dedupeKey);
  }
  if (kind) {
    conditions.push('kind = ?');
    params.push(kind);
  }
  if (!conditions.length) return null;
  if (!includeClosed) conditions.push(`status IN ('open','monitoring')`);

  return db.prepare(`
    SELECT *
    FROM active_incidents
    WHERE ${conditions.join(' AND ')}
    ORDER BY datetime(started_at) DESC, incident_key DESC
    LIMIT 1
  `).get(...params);
}

function buildIncidentKey(kind, dedupeKey, startedAt) {
  const safeKind = String(kind).trim().replace(/[^a-zA-Z0-9_-]+/g, '_');
  const safeDedupe = String(dedupeKey).trim().replace(/[^a-zA-Z0-9_-]+/g, '_');
  const safeStartedAt = String(startedAt).replace(/[^0-9]+/g, '');
  return `${safeKind}:${safeDedupe}:${safeStartedAt}`;
}


function incidentHasNotificationHistory(db, incidentKey) {
  if (!incidentKey) return false;
  try {
    return !!db.prepare(`
      SELECT 1
      FROM incident_notifications
      WHERE incident_key = ?
      LIMIT 1
    `).get(incidentKey);
  } catch {
    return false;
  }
}

function maybeRecordIncidentNotification(db, previousIncident, nextIncident, context = {}) {
  if (!nextIncident) return null;
  const hydratedPrevious = previousIncident
    ? { ...previousIncident, notified: previousIncident.notified === true || incidentHasNotificationHistory(db, previousIncident.incidentKey) }
    : null;
  const transitionType = shouldNotifyIncidentTransition(hydratedPrevious, nextIncident);
  if (!transitionType) return null;
  if (wasIncidentNotificationSent(db, { incidentKey: nextIncident.incidentKey, transitionType })) return null;
  const payload = buildIncidentNotification(nextIncident, {
    transitionType,
    actionResults: context.actionResults
  });
  const record = recordIncidentNotification(db, {
    incidentKey: nextIncident.incidentKey,
    transitionType,
    payload,
    sentAt: context.now
  });
  insertRunEvent(db, nextIncident, 'incident_notification_recorded', {
    transitionType,
    notification: payload
  });
  return { transitionType, payload, record };
}


export function openOrRefreshIncident(db, input = {}) {
  const kind = normalizeString(input.kind);
  const severity = normalizeString(input.severity);
  const dedupeKey = normalizeString(input.dedupeKey);
  const summary = normalizeString(input.summary, 'incident');
  if (!kind) throw new Error('kind is required');
  if (!severity) throw new Error('severity is required');
  if (!dedupeKey) throw new Error('dedupeKey is required');

  const now = toSqliteDateTime(input.now);
  const existingRow = findIncidentRow(db, { dedupeKey });
  const detailsJson = serializeDetails(input.details);
  const sourceEventId = Number.isInteger(input.sourceEventId) ? input.sourceEventId : null;

  if (existingRow) {
    db.prepare(`
      UPDATE active_incidents
      SET kind = ?,
          severity = ?,
          summary = ?,
          details_json = ?,
          source_event_id = ?,
          last_seen_at = ?,
          updated_at = ?
      WHERE incident_key = ?
    `).run(kind, severity, summary, detailsJson, sourceEventId, now, now, existingRow.incident_key);

    const previousIncident = {
      ...mapIncidentRow(existingRow),
      notified: incidentHasNotificationHistory(db, existingRow.incident_key)
    };
    const incident = mapIncidentRow(db.prepare(`SELECT * FROM active_incidents WHERE incident_key = ?`).get(existingRow.incident_key));
    insertRunEvent(db, incident, 'incident_updated', {
      previousStatus: existingRow.status,
      previousSeverity: existingRow.severity,
      details: incident.details
    });
    maybeRecordIncidentNotification(db, previousIncident, incident, { now });
    return incident;
  }

  const startedAt = now;
  const incidentKey = normalizeString(input.incidentKey) || buildIncidentKey(kind, dedupeKey, startedAt);
  db.prepare(`
    INSERT INTO active_incidents(
      incident_key,
      kind,
      severity,
      status,
      dedupe_key,
      summary,
      details_json,
      source_event_id,
      started_at,
      last_seen_at,
      updated_at
    )
    VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)
  `).run(incidentKey, kind, severity, dedupeKey, summary, detailsJson, sourceEventId, startedAt, startedAt, startedAt);

  const incident = mapIncidentRow(db.prepare(`SELECT * FROM active_incidents WHERE incident_key = ?`).get(incidentKey));
  insertRunEvent(db, incident, 'incident_opened', { details: incident.details });
  maybeRecordIncidentNotification(db, null, incident, { now });
  return incident;
}

export function transitionIncident(db, input = {}) {
  const existingRow = findIncidentRow(db, {
    incidentKey: normalizeString(input.incidentKey),
    dedupeKey: normalizeString(input.dedupeKey),
    kind: normalizeString(input.kind),
    includeClosed: true
  });
  if (!existingRow) return null;

  const now = toSqliteDateTime(input.now);
  const nextStatus = normalizeString(input.status) || existingRow.status;
  const nextSeverity = normalizeString(input.severity) || existingRow.severity;
  const nextSummary = normalizeString(input.summary, existingRow.summary);
  const nextDetailsJson = input.details === undefined ? existingRow.details_json : serializeDetails(input.details);
  const nextResolvedAt = nextStatus === 'resolved'
    ? (input.resolvedAt ? toSqliteDateTime(input.resolvedAt) : now)
    : null;
  const nextLastSeenAt = input.touchLastSeen === false ? existingRow.last_seen_at : now;
  const nextSourceEventId = Number.isInteger(input.sourceEventId) ? input.sourceEventId : existingRow.source_event_id;

  db.prepare(`
    UPDATE active_incidents
    SET severity = ?,
        status = ?,
        summary = ?,
        details_json = ?,
        source_event_id = ?,
        last_seen_at = ?,
        resolved_at = ?,
        updated_at = ?
    WHERE incident_key = ?
  `).run(nextSeverity, nextStatus, nextSummary, nextDetailsJson, nextSourceEventId, nextLastSeenAt, nextResolvedAt, now, existingRow.incident_key);

  const previousIncident = {
    ...mapIncidentRow(existingRow),
    notified: incidentHasNotificationHistory(db, existingRow.incident_key)
  };
  const incident = mapIncidentRow(db.prepare(`SELECT * FROM active_incidents WHERE incident_key = ?`).get(existingRow.incident_key));
  const eventType = nextStatus === 'resolved'
    ? 'incident_resolved'
    : nextStatus === 'suppressed'
      ? 'incident_suppressed'
      : 'incident_updated';
  insertRunEvent(db, incident, eventType, {
    previousStatus: existingRow.status,
    previousSeverity: existingRow.severity,
    details: incident.details
  });
  maybeRecordIncidentNotification(db, previousIncident, incident, {
    now,
    actionResults: incident.details?.actionResults
  });
  return incident;
}

export function resolveIncident(db, input = {}) {
  const existing = findIncidentRow(db, {
    incidentKey: normalizeString(input.incidentKey),
    dedupeKey: normalizeString(input.dedupeKey),
    kind: normalizeString(input.kind)
  });
  if (!existing) return null;
  return transitionIncident(db, {
    incidentKey: existing.incident_key,
    severity: existing.severity,
    summary: normalizeString(input.summary, existing.summary),
    details: input.details,
    sourceEventId: input.sourceEventId,
    status: 'resolved',
    now: input.now
  });
}

export function suppressIncident(db, input = {}) {
  const existing = findIncidentRow(db, {
    incidentKey: normalizeString(input.incidentKey),
    dedupeKey: normalizeString(input.dedupeKey),
    kind: normalizeString(input.kind)
  });
  if (!existing) return null;
  return transitionIncident(db, {
    incidentKey: existing.incident_key,
    severity: existing.severity,
    summary: normalizeString(input.summary, existing.summary),
    details: input.details,
    sourceEventId: input.sourceEventId,
    status: 'suppressed',
    now: input.now
  });
}

export function listActiveIncidents(db, options = {}) {
  const statuses = Array.isArray(options.statuses) && options.statuses.length
    ? options.statuses
    : ['open', 'monitoring'];
  const conditions = [`status IN (${statuses.map(() => '?').join(', ')})`];
  const params = [...statuses];

  if (options.kind) {
    conditions.push('kind = ?');
    params.push(String(options.kind));
  }
  if (options.severity) {
    conditions.push('severity = ?');
    params.push(String(options.severity));
  }

  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 100;
  const rows = db.prepare(`
    SELECT *
    FROM active_incidents
    WHERE ${conditions.join(' AND ')}
    ORDER BY CASE severity
      WHEN 'critical' THEN 3
      WHEN 'warn' THEN 2
      ELSE 1
    END DESC,
    datetime(last_seen_at) DESC,
    incident_key DESC
    LIMIT ?
  `).all(...params, limit);

  return rows.map(mapIncidentRow);
}

export function getIncidentSummary(db) {
  const incidents = listActiveIncidents(db);
  const bySeverity = { info: 0, warn: 0, critical: 0 };
  const byKind = {};

  for (const incident of incidents) {
    bySeverity[incident.severity] = (bySeverity[incident.severity] || 0) + 1;
    byKind[incident.kind] = (byKind[incident.kind] || 0) + 1;
  }

  const hasCritical = bySeverity.critical > 0;
  const requiresOperator = hasCritical || incidents.some((incident) => (
    incident.kind === 'account_challenge' || incident.kind === 'account_logged_out'
  ));

  return {
    totalActive: incidents.length,
    bySeverity,
    byKind,
    hasCritical,
    requiresOperator
  };
}
