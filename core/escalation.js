function toSqliteDateTime(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 19).replace('T', ' ');
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function normalizeTransitionType(value) {
  return String(value || '').trim();
}

function operatorActionRequired(incident) {
  return incident?.severity === 'critical'
    || incident?.kind === 'account_challenge'
    || incident?.kind === 'account_logged_out'
    || incident?.details?.finalFailure === true;
}

export function shouldNotifyIncidentTransition(previous, next) {
  if (!next) return null;
  const previousSeverity = previous?.severity || null;
  const nextSeverity = next?.severity || null;
  const opened = !previous && (next.status === 'open' || next.status === 'monitoring');
  const accountLockout = next.kind === 'account_challenge' || next.kind === 'account_logged_out';
  const finalRecoveryFailure = next.details?.finalFailure === true && previous?.details?.finalFailure !== true;

  if (opened && nextSeverity === 'critical') return 'opened_critical';
  if (opened && accountLockout) return 'opened_account_state';
  if (previous && previousSeverity !== 'critical' && nextSeverity === 'critical') return 'escalated_critical';
  if (finalRecoveryFailure) return 'recovery_failed_final';
  if (previous && previous.status !== 'resolved' && next.status === 'resolved' && (previousSeverity === 'critical' || previous?.notified === true)) {
    return 'resolved_notified_critical';
  }
  return null;
}

export function buildIncidentNotification(incident, context = {}) {
  const transitionType = normalizeTransitionType(context.transitionType) || 'incident_transition';
  const recoverySummary = Array.isArray(context.actionResults) && context.actionResults.length
    ? context.actionResults.map((entry) => `${entry.action}:${entry.ok ? 'ok' : 'fail'}`).join(', ')
    : (incident?.details?.actionResults ? incident.details.actionResults.map((entry) => `${entry.action}:${entry.ok ? 'ok' : 'fail'}`).join(', ') : 'none');

  return {
    incidentKey: incident?.incidentKey,
    transitionType,
    kind: incident?.kind,
    severity: incident?.severity,
    status: incident?.status,
    operatorActionRequired: operatorActionRequired(incident),
    text: [
      `incident=${incident?.kind || 'unknown'}`,
      `severity=${incident?.severity || 'unknown'}`,
      `status=${incident?.status || 'unknown'}`,
      `summary=${incident?.summary || 'n/a'}`,
      `recovery=${recoverySummary || 'none'}`,
      `operator_action=${operatorActionRequired(incident) ? 'required' : 'not_required'}`
    ].join(' | ')
  };
}

export function wasIncidentNotificationSent(db, input = {}) {
  const incidentKey = String(input.incidentKey || '').trim();
  const transitionType = normalizeTransitionType(input.transitionType);
  if (!incidentKey || !transitionType) return false;
  return !!db.prepare(`
    SELECT 1
    FROM incident_notifications
    WHERE incident_key = ? AND transition_type = ?
    LIMIT 1
  `).get(incidentKey, transitionType);
}

export function recordIncidentNotification(db, input = {}) {
  const incidentKey = String(input.incidentKey || '').trim();
  const transitionType = normalizeTransitionType(input.transitionType);
  if (!incidentKey) throw new Error('incidentKey is required');
  if (!transitionType) throw new Error('transitionType is required');
  const payloadJson = JSON.stringify(input.payload || null);
  db.prepare(`
    INSERT INTO incident_notifications(incident_key, transition_type, sent_at, payload_json)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(incident_key, transition_type) DO NOTHING
  `).run(incidentKey, transitionType, toSqliteDateTime(input.sentAt), payloadJson);

  return db.prepare(`
    SELECT id, incident_key, transition_type, sent_at, payload_json
    FROM incident_notifications
    WHERE incident_key = ? AND transition_type = ?
  `).get(incidentKey, transitionType);
}
