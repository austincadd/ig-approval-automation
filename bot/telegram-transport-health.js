function normalizeCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
}

function normalizeStatus(value) {
  return ['ok', 'degraded', 'fatal'].includes(value) ? value : 'ok';
}

function stableHealthShape(value = {}) {
  return {
    status: normalizeStatus(value.status),
    restartAttempts: normalizeCount(value.restartAttempts),
    duplicatePollerDetected: value.duplicatePollerDetected === true,
    sendFailures: normalizeCount(value.sendFailures),
    pollingErrors: normalizeCount(value.pollingErrors),
    lastError: value.lastError ? String(value.lastError) : null
  };
}

function readHealth(db) {
  try {
    const raw = db.prepare(`SELECT value FROM system_flags WHERE key='TELEGRAM_TRANSPORT_HEALTH'`).get()?.value;
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return {
      ...stableHealthShape(parsed),
      updatedAt: parsed?.updatedAt || null
    };
  } catch {
    return {};
  }
}

function writeHealth(db, next) {
  db.prepare(`
    INSERT INTO system_flags(key, value, updated_at)
    VALUES ('TELEGRAM_TRANSPORT_HEALTH', ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')
  `).run(JSON.stringify(next));
}

function logHealthChange(db, previous, next) {
  const previousStable = stableHealthShape(previous);
  const nextStable = stableHealthShape(next);
  const changed = JSON.stringify(previousStable) !== JSON.stringify(nextStable);
  if (!changed) return;
  db.prepare(`
    INSERT INTO run_events(job_id, level, event_type, payload_json)
    VALUES (NULL, ?, 'telegram_transport_health_changed', ?)
  `).run(nextStable.status === 'ok' ? 'info' : 'warn', JSON.stringify(next));
}

export function createTelegramTransportHealthStore(db) {
  function writeTransportHealth(patch = {}) {
    const existing = readHealth(db);
    const next = {
      ...stableHealthShape({
        status: 'ok',
        restartAttempts: 0,
        duplicatePollerDetected: false,
        sendFailures: 0,
        pollingErrors: 0,
        lastError: null,
        ...existing,
        ...patch
      }),
      updatedAt: new Date().toISOString()
    };
    writeHealth(db, next);
    logHealthChange(db, existing, next);
    return next;
  }

  return {
    readTransportHealth: () => readHealth(db),
    writeTransportHealth
  };
}

export function classifyTelegramError(err) {
  const code = String(err?.code || '').trim();
  const message = String(err?.message || err || '').toLowerCase();
  const duplicate = code === 'ETELEGRAM' && (message.includes('terminated by other getupdates request') || message.includes('409'));
  const transient = duplicate || message.includes('econnreset') || message.includes('socket hang up') || message.includes('timeout') || message.includes('terminated') || message.includes('network');
  return { code, message, duplicate, transient };
}
