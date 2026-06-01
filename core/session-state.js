function ensureSessionRow(db, accountKey = 'primary') {
  db.prepare(`
    INSERT INTO account_session_state(
      account_key,
      session_health,
      quarantine_state,
      quarantine_reason,
      trust_state,
      created_at,
      updated_at
    )
    VALUES (?, 'unknown', 'clear', NULL, 'unknown', datetime('now'), datetime('now'))
    ON CONFLICT(account_key) DO NOTHING
  `).run(accountKey);
}

function updateSessionRow(db, accountKey, patch = {}) {
  ensureSessionRow(db, accountKey);
  const current = db.prepare(`SELECT * FROM account_session_state WHERE account_key = ?`).get(accountKey);
  const next = {
    sessionHealth: patch.sessionHealth ?? current.session_health ?? 'unknown',
    lastLoginConfirmedAt: patch.lastLoginConfirmedAt ?? current.last_login_confirmed_at ?? null,
    lastChallengeAt: patch.lastChallengeAt ?? current.last_challenge_at ?? null,
    lastSuccessfulActionAt: patch.lastSuccessfulActionAt ?? current.last_successful_action_at ?? null,
    quarantineState: patch.quarantineState ?? current.quarantine_state ?? 'clear',
    quarantineReason: patch.quarantineReason === undefined ? (current.quarantine_reason ?? null) : patch.quarantineReason,
    trustState: patch.trustState ?? current.trust_state ?? 'unknown',
    trustReason: patch.trustReason === undefined ? (current.trust_reason ?? null) : patch.trustReason,
    challengeAcknowledgedAt: patch.challengeAcknowledgedAt ?? current.challenge_acknowledged_at ?? null,
    recoveryAcknowledgedAt: patch.recoveryAcknowledgedAt ?? current.recovery_acknowledged_at ?? null,
    revalidatedAt: patch.revalidatedAt ?? current.revalidated_at ?? null,
    lastObservedAt: patch.lastObservedAt ?? new Date().toISOString(),
    metadataJson: patch.metadataJson === undefined ? (current.metadata_json ?? null) : patch.metadataJson
  };

  db.prepare(`
    UPDATE account_session_state
    SET session_health = ?,
        last_login_confirmed_at = ?,
        last_challenge_at = ?,
        last_successful_action_at = ?,
        quarantine_state = ?,
        quarantine_reason = ?,
        trust_state = ?,
        trust_reason = ?,
        challenge_acknowledged_at = ?,
        recovery_acknowledged_at = ?,
        revalidated_at = ?,
        last_observed_at = ?,
        metadata_json = ?,
        updated_at = datetime('now')
    WHERE account_key = ?
  `).run(
    next.sessionHealth,
    next.lastLoginConfirmedAt,
    next.lastChallengeAt,
    next.lastSuccessfulActionAt,
    next.quarantineState,
    next.quarantineReason,
    next.trustState,
    next.trustReason,
    next.challengeAcknowledgedAt,
    next.recoveryAcknowledgedAt,
    next.revalidatedAt,
    next.lastObservedAt,
    next.metadataJson,
    accountKey
  );

  return readAccountSessionState(db, accountKey);
}

export function readAccountSessionState(db, accountKey = 'primary') {
  ensureSessionRow(db, accountKey);
  const row = db.prepare(`SELECT * FROM account_session_state WHERE account_key = ?`).get(accountKey);
  return {
    accountKey: row.account_key,
    sessionHealth: row.session_health,
    lastLoginConfirmedAt: row.last_login_confirmed_at,
    lastChallengeAt: row.last_challenge_at,
    lastSuccessfulActionAt: row.last_successful_action_at,
    quarantineState: row.quarantine_state,
    quarantineReason: row.quarantine_reason,
    trustState: row.trust_state || 'unknown',
    trustReason: row.trust_reason,
    challengeAcknowledgedAt: row.challenge_acknowledged_at,
    recoveryAcknowledgedAt: row.recovery_acknowledged_at,
    revalidatedAt: row.revalidated_at,
    lastObservedAt: row.last_observed_at,
    metadata: (() => {
      try { return row.metadata_json ? JSON.parse(row.metadata_json) : null; } catch { return null; }
    })(),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function recordSessionLoginConfirmed(db, input = {}) {
  const observedAt = input.observedAt || new Date().toISOString();
  return updateSessionRow(db, input.accountKey || 'primary', {
    sessionHealth: 'ok',
    quarantineState: 'clear',
    quarantineReason: null,
    trustState: 'trusted',
    trustReason: 'login_confirmed',
    revalidatedAt: observedAt,
    lastLoginConfirmedAt: observedAt,
    lastObservedAt: observedAt,
    metadataJson: input.metadata ? JSON.stringify(input.metadata) : undefined
  });
}

export function recordSessionChallenge(db, input = {}) {
  const observedAt = input.observedAt || new Date().toISOString();
  return updateSessionRow(db, input.accountKey || 'primary', {
    sessionHealth: 'challenge',
    quarantineState: input.quarantineState || 'quarantined',
    quarantineReason: input.reason || 'challenge_detected',
    trustState: 'untrusted',
    trustReason: input.reason || 'challenge_detected',
    challengeAcknowledgedAt: null,
    recoveryAcknowledgedAt: null,
    revalidatedAt: null,
    lastChallengeAt: observedAt,
    lastObservedAt: observedAt,
    metadataJson: input.metadata ? JSON.stringify(input.metadata) : undefined
  });
}

export function recordSessionLogout(db, input = {}) {
  const observedAt = input.observedAt || new Date().toISOString();
  return updateSessionRow(db, input.accountKey || 'primary', {
    sessionHealth: 'logged_out',
    quarantineState: input.quarantineState || 'quarantined',
    quarantineReason: input.reason || 'logged_out',
    trustState: 'untrusted',
    trustReason: input.reason || 'logged_out',
    recoveryAcknowledgedAt: null,
    revalidatedAt: null,
    lastObservedAt: observedAt,
    metadataJson: input.metadata ? JSON.stringify(input.metadata) : undefined
  });
}

export function recordSuccessfulAction(db, input = {}) {
  const observedAt = input.observedAt || new Date().toISOString();
  return updateSessionRow(db, input.accountKey || 'primary', {
    sessionHealth: 'ok',
    quarantineState: 'clear',
    quarantineReason: null,
    trustState: 'trusted',
    trustReason: 'successful_action',
    revalidatedAt: observedAt,
    lastSuccessfulActionAt: observedAt,
    lastObservedAt: observedAt,
    metadataJson: input.metadata ? JSON.stringify(input.metadata) : undefined
  });
}

export function setSessionQuarantine(db, input = {}) {
  return updateSessionRow(db, input.accountKey || 'primary', {
    quarantineState: input.quarantineState || 'quarantined',
    quarantineReason: input.reason || null,
    sessionHealth: input.sessionHealth,
    trustState: input.trustState,
    trustReason: input.trustReason,
    challengeAcknowledgedAt: input.challengeAcknowledgedAt,
    recoveryAcknowledgedAt: input.recoveryAcknowledgedAt,
    revalidatedAt: input.revalidatedAt,
    lastObservedAt: input.observedAt || new Date().toISOString(),
    metadataJson: input.metadata ? JSON.stringify(input.metadata) : undefined
  });
}
