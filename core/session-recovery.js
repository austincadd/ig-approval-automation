function safeMetadata(input) {
  return input?.metadata ? JSON.stringify(input.metadata) : undefined;
}

export function acknowledgeSessionChallenge(db, input = {}) {
  const observedAt = input.observedAt || new Date().toISOString();
  db.prepare(`
    UPDATE account_session_state
    SET challenge_acknowledged_at = ?,
        trust_state = 'pending_revalidation',
        trust_reason = ?,
        quarantine_state = 'quarantined',
        quarantine_reason = COALESCE(quarantine_reason, ?),
        last_observed_at = ?,
        metadata_json = COALESCE(?, metadata_json),
        updated_at = datetime('now')
    WHERE account_key = ?
  `).run(observedAt, input.reason || 'challenge_acknowledged', input.reason || 'challenge_acknowledged', observedAt, safeMetadata(input), input.accountKey || 'primary');
  db.prepare(`INSERT INTO run_events(job_id, level, event_type, payload_json) VALUES (NULL, 'warn', 'session_challenge_acknowledged', json(?))`)
    .run(JSON.stringify({ accountKey: input.accountKey || 'primary', observedAt, reason: input.reason || 'challenge_acknowledged' }));
}

export function acknowledgeSessionRecovery(db, input = {}) {
  const observedAt = input.observedAt || new Date().toISOString();
  db.prepare(`
    UPDATE account_session_state
    SET recovery_acknowledged_at = ?,
        trust_state = 'pending_revalidation',
        trust_reason = ?,
        quarantine_state = 'quarantined',
        quarantine_reason = COALESCE(quarantine_reason, ?),
        last_observed_at = ?,
        metadata_json = COALESCE(?, metadata_json),
        updated_at = datetime('now')
    WHERE account_key = ?
  `).run(observedAt, input.reason || 'recovery_acknowledged', input.reason || 'recovery_acknowledged', observedAt, safeMetadata(input), input.accountKey || 'primary');
  db.prepare(`INSERT INTO run_events(job_id, level, event_type, payload_json) VALUES (NULL, 'warn', 'session_recovery_acknowledged', json(?))`)
    .run(JSON.stringify({ accountKey: input.accountKey || 'primary', observedAt, reason: input.reason || 'recovery_acknowledged' }));
}

export function markSessionRevalidated(db, input = {}) {
  const observedAt = input.observedAt || new Date().toISOString();
  db.prepare(`
    UPDATE account_session_state
    SET revalidated_at = ?,
        trust_state = 'trusted',
        trust_reason = ?,
        session_health = 'ok',
        quarantine_state = 'clear',
        quarantine_reason = NULL,
        last_login_confirmed_at = COALESCE(?, last_login_confirmed_at),
        last_observed_at = ?,
        metadata_json = COALESCE(?, metadata_json),
        updated_at = datetime('now')
    WHERE account_key = ?
  `).run(observedAt, input.reason || 'session_revalidated', input.lastLoginConfirmedAt || observedAt, observedAt, safeMetadata(input), input.accountKey || 'primary');
  db.prepare(`INSERT INTO run_events(job_id, level, event_type, payload_json) VALUES (NULL, 'info', 'session_revalidated', json(?))`)
    .run(JSON.stringify({ accountKey: input.accountKey || 'primary', observedAt, reason: input.reason || 'session_revalidated' }));
}
