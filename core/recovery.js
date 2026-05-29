export function recoveryResult(status, extras = {}) {
  return { status, ...extras };
}

function normalizeActor(actor) {
  return String(actor || 'system').trim() || 'system';
}

function normalizeReason(reason) {
  const value = String(reason || '').trim();
  return value || null;
}

function ensureFlagRow(db, key, fallbackValue) {
  db.prepare(`
    INSERT INTO system_flags(key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO NOTHING
  `).run(key, String(fallbackValue));
}

function setFlag(db, key, value) {
  ensureFlagRow(db, key, value);
  db.prepare(`
    UPDATE system_flags
    SET value = ?, updated_at = datetime('now')
    WHERE key = ?
  `).run(String(value), key);
}

function getFlag(db, key, fallbackValue = null) {
  const row = db.prepare('SELECT value FROM system_flags WHERE key = ?').get(key);
  return row?.value ?? fallbackValue;
}

function insertRunEvent(db, { jobId = null, level = 'info', eventType, payload = {} }) {
  db.prepare(`
    INSERT INTO run_events(job_id, level, event_type, payload_json)
    VALUES (?, ?, ?, ?)
  `).run(jobId, level, eventType, JSON.stringify(payload));
}

function activeJobExists(db, candidateId) {
  return !!db.prepare(`
    SELECT id
    FROM like_jobs
    WHERE candidate_id = ?
      AND status IN ('queued', 'running')
    LIMIT 1
  `).get(candidateId);
}

function countJobsByStatus(db) {
  const rows = db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM like_jobs
    GROUP BY status
  `).all();

  const counts = {
    queued: 0,
    running: 0,
    success: 0,
    failed: 0,
    blocked: 0,
    stopped: 0
  };

  for (const row of rows) {
    if (row?.status in counts) counts[row.status] = row.count;
  }

  return counts;
}

function getCurrentBlockedRows(db, limit = 5) {
  return db.prepare(`
    SELECT lj.id, lj.candidate_id, c.post_url, lj.status, lj.error_code, lj.error_message, lj.failure_class, lj.failure_policy, lj.updated_at
    FROM like_jobs lj
    JOIN candidates c ON c.id = lj.candidate_id
    WHERE lj.status IN ('failed', 'blocked')
      AND lj.id = (
        SELECT latest.id
        FROM like_jobs latest
        WHERE latest.candidate_id = lj.candidate_id
        ORDER BY datetime(COALESCE(latest.finished_at, latest.updated_at, latest.created_at)) DESC, latest.id DESC
        LIMIT 1
      )
    ORDER BY datetime(COALESCE(lj.finished_at, lj.updated_at, lj.created_at)) DESC, lj.id DESC
    LIMIT ?
  `).all(limit).map((row) => ({
    jobId: row.id,
    candidateId: row.candidate_id,
    postUrl: row.post_url,
    status: row.status,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    failureClass: row.failure_class,
    failurePolicy: row.failure_policy,
    updatedAt: row.updated_at
  }));
}

function getHistoricalBlockedRows(db, limit = 5) {
  return db.prepare(`
    SELECT lj.id, lj.candidate_id, c.post_url, lj.status, lj.error_code, lj.error_message, lj.updated_at
    FROM like_jobs lj
    JOIN candidates c ON c.id = lj.candidate_id
    WHERE lj.status IN ('failed', 'blocked')
      AND EXISTS (
        SELECT 1
        FROM like_jobs newer
        WHERE newer.candidate_id = lj.candidate_id
          AND datetime(COALESCE(newer.finished_at, newer.updated_at, newer.created_at)) > datetime(COALESCE(lj.finished_at, lj.updated_at, lj.created_at))
      )
    ORDER BY datetime(COALESCE(lj.finished_at, lj.updated_at, lj.created_at)) DESC, lj.id DESC
    LIMIT ?
  `).all(limit).map((row) => ({
    jobId: row.id,
    candidateId: row.candidate_id,
    postUrl: row.post_url,
    status: row.status,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    updatedAt: row.updated_at
  }));
}

function getRecoverySuppressedRows(db, limit = 5) {
  return db.prepare(`
    SELECT rs.candidate_id, c.post_url, rs.reason, rs.created_by, rs.created_at
    FROM recovery_suppressions rs
    JOIN candidates c ON c.id = rs.candidate_id
    ORDER BY rs.candidate_id ASC
    LIMIT ?
  `).all(limit).map((row) => ({
    candidateId: row.candidate_id,
    postUrl: row.post_url,
    reason: row.reason,
    createdBy: row.created_by,
    createdAt: row.created_at
  }));
}

function getApprovedWithoutActiveRows(db, limit = 5) {
  return db.prepare(`
    SELECT a.candidate_id,
           c.post_url,
           a.decided_at,
           latest.id AS latest_job_id,
           latest.status AS latest_job_status,
           latest.error_code AS latest_error_code,
           latest.error_message AS latest_error_message
    FROM approvals a
    JOIN candidates c ON c.id = a.candidate_id
    LEFT JOIN like_jobs latest ON latest.id = (
      SELECT lj.id
      FROM like_jobs lj
      WHERE lj.candidate_id = a.candidate_id
      ORDER BY datetime(COALESCE(lj.finished_at, lj.updated_at, lj.created_at)) DESC, lj.id DESC
      LIMIT 1
    )
    WHERE a.decision = 'approved'
      AND NOT EXISTS (
        SELECT 1
        FROM recovery_suppressions rs
        WHERE rs.candidate_id = a.candidate_id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM like_jobs active
        WHERE active.candidate_id = a.candidate_id
          AND active.status IN ('queued', 'running')
      )
      AND NOT EXISTS (
        SELECT 1
        FROM like_jobs done
        WHERE done.candidate_id = a.candidate_id
          AND done.status = 'success'
      )
    ORDER BY a.candidate_id ASC
    LIMIT ?
  `).all(limit).map((row) => ({
    candidateId: row.candidate_id,
    postUrl: row.post_url,
    decidedAt: row.decided_at,
    latestJobId: row.latest_job_id ?? null,
    latestJobStatus: row.latest_job_status ?? null,
    latestErrorCode: row.latest_error_code ?? null,
    latestErrorMessage: row.latest_error_message ?? null
  }));
}

export function getAutomationStatus(db) {
  ensureFlagRow(db, 'AUTOMATION_ENABLED', 'true');
  ensureFlagRow(db, 'DAILY_LIMIT', '10');
  ensureFlagRow(db, 'HOURLY_LIMIT', '3');

  const automationEnabled = String(getFlag(db, 'AUTOMATION_ENABLED', 'true')).toLowerCase() === 'true';
  const counts = countJobsByStatus(db);
  const pendingApprovals = db.prepare(`
    SELECT COUNT(*) AS count
    FROM candidates c
    LEFT JOIN approvals a ON a.candidate_id = c.id
    WHERE a.id IS NULL
  `).get().count;
  const approvedWithoutActive = db.prepare(`
    SELECT COUNT(*) AS count
    FROM approvals a
    WHERE a.decision = 'approved'
      AND NOT EXISTS (
        SELECT 1
        FROM recovery_suppressions rs
        WHERE rs.candidate_id = a.candidate_id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM like_jobs lj
        WHERE lj.candidate_id = a.candidate_id
          AND lj.status IN ('queued', 'running')
      )
      AND NOT EXISTS (
        SELECT 1
        FROM like_jobs lj
        WHERE lj.candidate_id = a.candidate_id
          AND lj.status = 'success'
      )
  `).get().count;

  const recoverySuppressedCount = db.prepare(`SELECT COUNT(*) AS count FROM recovery_suppressions`).get().count;

  const currentBlocked = getCurrentBlockedRows(db, 5);
  const historicalBlocked = getHistoricalBlockedRows(db, 5);

  return recoveryResult('ok', {
    automationEnabled,
    flags: {
      dailyLimit: Number(getFlag(db, 'DAILY_LIMIT', '10')),
      hourlyLimit: Number(getFlag(db, 'HOURLY_LIMIT', '3'))
    },
    counts,
    pendingApprovals,
    approvedWithoutActive,
    approvedWithoutActiveCandidates: getApprovedWithoutActiveRows(db, 5),
    recoverySuppressedCount,
    recoverySuppressedCandidates: getRecoverySuppressedRows(db, 5),
    currentBlocked,
    historicalBlocked,
    activeBlockerCount: currentBlocked.length,
    historicalBlockedCount: historicalBlocked.length
  });
}

export function pauseAutomation(db, input = {}) {
  const actor = normalizeActor(input.actor);
  const reason = normalizeReason(input.reason);
  const statusBefore = getAutomationStatus(db);

  setFlag(db, 'AUTOMATION_ENABLED', 'false');
  insertRunEvent(db, {
    eventType: 'automation_paused',
    payload: {
      actor,
      reason,
      automationEnabledBefore: statusBefore.automationEnabled
    }
  });

  return recoveryResult('ok', {
    changed: statusBefore.automationEnabled,
    automationEnabled: false,
    actor,
    reason
  });
}

export function resumeAutomation(db, input = {}) {
  const actor = normalizeActor(input.actor);
  const reason = normalizeReason(input.reason);
  const statusBefore = getAutomationStatus(db);

  setFlag(db, 'AUTOMATION_ENABLED', 'true');
  insertRunEvent(db, {
    eventType: 'automation_resumed',
    payload: {
      actor,
      reason,
      automationEnabledBefore: statusBefore.automationEnabled
    }
  });

  const statusAfter = getAutomationStatus(db);

  return recoveryResult('ok', {
    changed: !statusBefore.automationEnabled,
    automationEnabled: true,
    actor,
    reason,
    counts: statusAfter.counts,
    approvedWithoutActive: statusAfter.approvedWithoutActive,
    approvedWithoutActiveCandidates: statusAfter.approvedWithoutActiveCandidates,
    recoverySuppressedCount: statusAfter.recoverySuppressedCount,
    recoverySuppressedCandidates: statusAfter.recoverySuppressedCandidates
  });
}

export function requeueBlockedJobs(db, input = {}) {
  const actor = normalizeActor(input.actor);
  const reason = normalizeReason(input.reason) || 'manual_requeue_blocked';

  const candidates = db.prepare(`
    SELECT lj.id, lj.candidate_id
    FROM like_jobs lj
    WHERE lj.status = 'blocked'
      AND NOT EXISTS (
        SELECT 1
        FROM recovery_suppressions rs
        WHERE rs.candidate_id = lj.candidate_id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM like_jobs active
        WHERE active.candidate_id = lj.candidate_id
          AND active.status IN ('queued', 'running')
      )
      AND NOT EXISTS (
        SELECT 1
        FROM like_jobs done
        WHERE done.candidate_id = lj.candidate_id
          AND done.status = 'success'
      )
      AND lj.id = (
        SELECT latest.id
        FROM like_jobs latest
        WHERE latest.candidate_id = lj.candidate_id
        ORDER BY datetime(COALESCE(latest.finished_at, latest.updated_at, latest.created_at)) DESC, latest.id DESC
        LIMIT 1
      )
    ORDER BY lj.id ASC
  `).all();

  const insertJob = db.prepare(`
    INSERT INTO like_jobs(candidate_id, status, scheduled_at, error_code, error_message, session_id, created_at, updated_at)
    VALUES (?, 'queued', datetime('now'), NULL, NULL, NULL, datetime('now'), datetime('now'))
  `);

  const created = [];
  const skipped = [];

  const tx = db.transaction(() => {
    for (const row of candidates) {
      if (activeJobExists(db, row.candidate_id)) {
        skipped.push({ candidateId: row.candidate_id, blockedJobId: row.id, reason: 'ACTIVE_JOB_EXISTS' });
        continue;
      }
      const result = insertJob.run(row.candidate_id);
      const newJobId = Number(result.lastInsertRowid);
      created.push({ candidateId: row.candidate_id, blockedJobId: row.id, newJobId });
      insertRunEvent(db, {
        jobId: newJobId,
        eventType: 'job_requeued_from_blocked',
        payload: { actor, reason, blockedJobId: row.id }
      });
    }
  });

  tx();

  return recoveryResult('ok', {
    actor,
    reason,
    created,
    skipped,
    createdCount: created.length,
    skippedCount: skipped.length
  });
}

export function reconcileApprovedQueue(db, input = {}) {
  const actor = normalizeActor(input.actor);
  const reason = normalizeReason(input.reason) || 'manual_reconcile_approved';

  const rows = db.prepare(`
    SELECT a.candidate_id
    FROM approvals a
    WHERE a.decision = 'approved'
      AND NOT EXISTS (
        SELECT 1
        FROM recovery_suppressions rs
        WHERE rs.candidate_id = a.candidate_id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM like_jobs active
        WHERE active.candidate_id = a.candidate_id
          AND active.status IN ('queued', 'running')
      )
      AND NOT EXISTS (
        SELECT 1
        FROM like_jobs done
        WHERE done.candidate_id = a.candidate_id
          AND done.status = 'success'
      )
    ORDER BY a.candidate_id ASC
  `).all();

  const insertJob = db.prepare(`
    INSERT INTO like_jobs(candidate_id, status, scheduled_at, error_code, error_message, session_id, created_at, updated_at)
    VALUES (?, 'queued', datetime('now'), NULL, NULL, NULL, datetime('now'), datetime('now'))
  `);

  const created = [];
  const skipped = [];

  const tx = db.transaction(() => {
    for (const row of rows) {
      if (activeJobExists(db, row.candidate_id)) {
        skipped.push({ candidateId: row.candidate_id, reason: 'ACTIVE_JOB_EXISTS' });
        continue;
      }
      const result = insertJob.run(row.candidate_id);
      const newJobId = Number(result.lastInsertRowid);
      created.push({ candidateId: row.candidate_id, newJobId });
      insertRunEvent(db, {
        jobId: newJobId,
        eventType: 'job_reconciled_from_approval',
        payload: { actor, reason }
      });
    }
  });

  tx();

  return recoveryResult('ok', {
    actor,
    reason,
    created,
    skipped,
    createdCount: created.length,
    skippedCount: skipped.length
  });
}

export function suppressRecoveryCandidate(db, input = {}) {
  const actor = normalizeActor(input.actor);
  const candidateId = Number(input.candidateId);
  if (!Number.isSafeInteger(candidateId) || candidateId <= 0) {
    throw new Error(`Invalid candidateId: ${input.candidateId}`);
  }

  const reason = normalizeReason(input.reason) || 'manual_recovery_suppression';
  const candidate = db.prepare(`SELECT id, post_url FROM candidates WHERE id = ?`).get(candidateId);
  if (!candidate) {
    throw new Error(`Candidate ${candidateId} not found`);
  }

  const existing = db.prepare(`SELECT candidate_id, reason, created_by, created_at FROM recovery_suppressions WHERE candidate_id = ?`).get(candidateId);
  db.prepare(`
    INSERT INTO recovery_suppressions(candidate_id, reason, created_by, created_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(candidate_id) DO UPDATE SET
      reason = excluded.reason,
      created_by = excluded.created_by,
      created_at = excluded.created_at
  `).run(candidateId, reason, actor);

  insertRunEvent(db, {
    eventType: 'candidate_recovery_suppressed',
    payload: {
      actor,
      candidateId,
      postUrl: candidate.post_url,
      reason,
      previousReason: existing?.reason || null
    }
  });

  return recoveryResult('ok', {
    actor,
    candidateId,
    postUrl: candidate.post_url,
    reason,
    changed: !existing || existing.reason !== reason || existing.created_by !== actor,
    previousReason: existing?.reason || null
  });
}

export function claimNextQueuedJob(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare(`
      SELECT lj.id, lj.candidate_id, c.post_url
      FROM like_jobs lj
      JOIN candidates c ON c.id = lj.candidate_id
      WHERE lj.status = 'queued'
      ORDER BY datetime(lj.created_at) ASC, lj.id ASC
      LIMIT 1
    `).get();

    if (!row) {
      db.exec('COMMIT');
      return null;
    }

    const update = db.prepare(`
      UPDATE like_jobs
      SET status = 'running',
          started_at = datetime('now'),
          updated_at = datetime('now'),
          attempt_count = attempt_count + 1
      WHERE id = ? AND status = 'queued'
    `).run(row.id);

    if (update.changes !== 1) {
      db.exec('ROLLBACK');
      return null;
    }

    db.exec('COMMIT');
    return row;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch {}
    throw err;
  }
}
