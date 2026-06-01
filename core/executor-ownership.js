import process from 'node:process';

function nowIso() {
  return new Date().toISOString();
}

function pidLooksAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function safeJson(value) {
  return value == null ? null : JSON.stringify(value);
}

function parseDetails(value) {
  try { return value ? JSON.parse(value) : null; } catch { return null; }
}

export function getExecutorOwner(db, ownerKey = 'browser-profile') {
  const row = db.prepare(`SELECT * FROM executor_owners WHERE owner_key = ?`).get(ownerKey);
  if (!row) return null;
  return {
    ownerKey: row.owner_key,
    mode: row.mode,
    pid: row.pid,
    profileDir: row.profile_dir,
    state: row.state,
    startedAt: row.started_at,
    heartbeatAt: row.heartbeat_at,
    releasedAt: row.released_at,
    reclaimedAt: row.reclaimed_at,
    details: parseDetails(row.details_json),
    updatedAt: row.updated_at,
    pidAlive: pidLooksAlive(Number(row.pid))
  };
}

export function acquireExecutorOwner(db, input = {}) {
  const ownerKey = input.ownerKey || 'browser-profile';
  const existing = getExecutorOwner(db, ownerKey);
  const observedAt = input.observedAt || nowIso();
  if (existing && existing.state === 'active' && existing.pidAlive && Number(existing.pid) !== Number(input.pid || process.pid)) {
    const err = new Error(`Executor owner already active (${existing.mode})`);
    err.code = 'EXECUTOR_OWNER_ACTIVE';
    err.owner = existing;
    throw err;
  }

  db.prepare(`
    INSERT INTO executor_owners(owner_key, mode, pid, profile_dir, state, started_at, heartbeat_at, released_at, reclaimed_at, details_json, updated_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?, NULL, NULL, ?, datetime('now'))
    ON CONFLICT(owner_key) DO UPDATE SET
      mode=excluded.mode,
      pid=excluded.pid,
      profile_dir=excluded.profile_dir,
      state='active',
      started_at=excluded.started_at,
      heartbeat_at=excluded.heartbeat_at,
      released_at=NULL,
      reclaimed_at=NULL,
      details_json=excluded.details_json,
      updated_at=datetime('now')
  `).run(ownerKey, input.mode || 'unknown', Number(input.pid || process.pid), input.profileDir || '.browser-profile', observedAt, observedAt, safeJson(input.details));

  db.prepare(`INSERT INTO run_events(job_id, level, event_type, payload_json) VALUES (NULL, 'info', 'executor_acquired', json(?))`)
    .run(JSON.stringify({ ownerKey, mode: input.mode || 'unknown', pid: Number(input.pid || process.pid), profileDir: input.profileDir || '.browser-profile', observedAt }));

  return getExecutorOwner(db, ownerKey);
}

export function heartbeatExecutorOwner(db, input = {}) {
  const ownerKey = input.ownerKey || 'browser-profile';
  const observedAt = input.observedAt || nowIso();
  db.prepare(`
    UPDATE executor_owners
    SET heartbeat_at = ?,
        details_json = COALESCE(?, details_json),
        updated_at = datetime('now')
    WHERE owner_key = ?
  `).run(observedAt, safeJson(input.details), ownerKey);
  db.prepare(`INSERT INTO run_events(job_id, level, event_type, payload_json) VALUES (NULL, 'info', 'executor_heartbeat', json(?))`)
    .run(JSON.stringify({ ownerKey, observedAt }));
  return getExecutorOwner(db, ownerKey);
}

export function releaseExecutorOwner(db, input = {}) {
  const ownerKey = input.ownerKey || 'browser-profile';
  const observedAt = input.observedAt || nowIso();
  db.prepare(`
    UPDATE executor_owners
    SET state='released',
        released_at=?,
        heartbeat_at=?,
        updated_at=datetime('now')
    WHERE owner_key = ?
  `).run(observedAt, observedAt, ownerKey);
  db.prepare(`INSERT INTO run_events(job_id, level, event_type, payload_json) VALUES (NULL, 'info', 'executor_released', json(?))`)
    .run(JSON.stringify({ ownerKey, observedAt }));
  return getExecutorOwner(db, ownerKey);
}

export function evaluateExecutorOwner(db, input = {}) {
  const owner = getExecutorOwner(db, input.ownerKey || 'browser-profile');
  const staleAfterMs = input.staleAfterMs ?? 2 * 60 * 1000;
  if (!owner) return { state: 'absent', owner: null, stale: false, reclaimable: false };
  const heartbeatMs = owner.heartbeatAt ? new Date(owner.heartbeatAt).getTime() : 0;
  const ageMs = heartbeatMs ? Math.max(0, Date.now() - heartbeatMs) : null;
  const stale = owner.state === 'active' && (!owner.pidAlive || (ageMs != null && ageMs > staleAfterMs));
  return {
    state: stale ? 'stale' : owner.state,
    owner,
    stale,
    reclaimable: stale,
    ageMs
  };
}

export function reclaimExecutorOwner(db, input = {}) {
  const ownerKey = input.ownerKey || 'browser-profile';
  const evaluation = evaluateExecutorOwner(db, input);
  const observedAt = input.observedAt || nowIso();
  if (!evaluation.reclaimable) {
    db.prepare(`INSERT INTO run_events(job_id, level, event_type, payload_json) VALUES (NULL, 'warn', 'executor_reclaim_blocked', json(?))`)
      .run(JSON.stringify({ ownerKey, observedAt, evaluation }));
    return { ok: false, evaluation };
  }
  db.prepare(`
    UPDATE executor_owners
    SET state='reclaimed',
        reclaimed_at=?,
        updated_at=datetime('now')
    WHERE owner_key = ?
  `).run(observedAt, ownerKey);
  db.prepare(`INSERT INTO run_events(job_id, level, event_type, payload_json) VALUES (NULL, 'warn', 'executor_reclaim_succeeded', json(?))`)
    .run(JSON.stringify({ ownerKey, observedAt, previous: evaluation.owner }));
  return { ok: true, owner: getExecutorOwner(db, ownerKey) };
}
