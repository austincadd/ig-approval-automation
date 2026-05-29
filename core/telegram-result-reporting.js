const TERMINAL_JOB_EVENT_TYPES = ['job_success', 'job_failed', 'job_blocked'];
const TERMINAL_JOB_EVENT_TYPE_SET = new Set(TERMINAL_JOB_EVENT_TYPES);
const DEFAULT_BATCH_LIMIT = 10;
const DEFAULT_MAX_MESSAGE_LENGTH = 3500;

function safeParseJson(value) {
  try {
    return JSON.parse(value || '{}');
  } catch {
    return {};
  }
}

function truncateText(value, maxLength = 280) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

function normalizeNumericId(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : null;
}

export function readTelegramResultCursor(db) {
  const raw = db.prepare(`SELECT value FROM system_flags WHERE key='TELEGRAM_RESULT_EVENT_CURSOR'`).get()?.value;
  return normalizeNumericId(raw);
}

export function writeTelegramResultCursor(db, id) {
  db.prepare(`
    INSERT INTO system_flags(key, value, updated_at)
    VALUES ('TELEGRAM_RESULT_EVENT_CURSOR', ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')
  `).run(String(Math.max(0, Math.trunc(Number(id) || 0))));
}

export function getLatestTelegramResultEventId(db) {
  const row = db.prepare(`
    SELECT MAX(id) AS id
    FROM run_events
    WHERE event_type IN (${TERMINAL_JOB_EVENT_TYPES.map(() => '?').join(', ')})
  `).get(...TERMINAL_JOB_EVENT_TYPES);
  return Number(row?.id || 0);
}

export function readTelegramResultEvents(db, input = {}) {
  const afterId = Math.max(0, Math.trunc(Number(input.afterId) || 0));
  const limit = Math.max(1, Math.trunc(Number(input.limit) || DEFAULT_BATCH_LIMIT));

  return db.prepare(`
    SELECT re.id,
           re.job_id,
           re.event_type,
           re.payload_json,
           re.created_at,
           lj.candidate_id,
           c.post_url,
           lj.error_code,
           lj.error_message,
           lj.failure_class,
           lj.failure_policy,
           lj.evidence_bundle_path
    FROM run_events re
    LEFT JOIN like_jobs lj ON lj.id = re.job_id
    LEFT JOIN candidates c ON c.id = lj.candidate_id
    WHERE re.id > ?
      AND re.event_type IN (${TERMINAL_JOB_EVENT_TYPES.map(() => '?').join(', ')})
    ORDER BY re.id ASC
    LIMIT ?
  `).all(afterId, ...TERMINAL_JOB_EVENT_TYPES, limit).map((row) => ({
    id: row.id,
    job_id: row.job_id,
    event_type: row.event_type,
    created_at: row.created_at,
    candidate_id: row.candidate_id,
    post_url: row.post_url,
    error_code: row.error_code,
    error_message: row.error_message,
    failure_class: row.failure_class,
    failure_policy: row.failure_policy,
    evidence_bundle_path: row.evidence_bundle_path,
    payload: safeParseJson(row.payload_json)
  }));
}

export function formatTelegramResultReason(event, payload = {}) {
  if (event.event_type === 'job_success') {
    const outcomeMap = {
      already_liked: 'already liked',
      clicked_and_verified: 'clicked and verified'
    };
    return `Outcome: ${outcomeMap[payload.outcome] || 'success'}`;
  }

  const error = payload.error || {};
  const code = truncateText(error.code || event.error_code || 'UNKNOWN', 80);
  const message = truncateText(error.message || event.error_message || 'No error message recorded.', 280);
  const guidanceMap = {
    LIKE_BUTTON_NOT_FOUND: 'Likely selector drift; inspect the evidence bundle before retrying.',
    LIKE_STATE_NOT_CONFIRMED: 'Verification did not settle cleanly; inspect the evidence bundle before retrying.',
    CHECKPOINT_DETECTED: 'Instagram challenge/checkpoint detected; clear browser state before retrying.',
    CANARY_ACTION_SURFACE_MISSING: 'Executor canary failed before claim; inspect action-surface evidence.',
    CANARY_NOT_LOGGED_IN: 'Executor session is logged out; operator action required.'
  };

  return [
    `Error: ${code}`,
    event.failure_class ? `Class: ${event.failure_class}` : null,
    event.failure_policy ? `Policy: ${event.failure_policy}` : null,
    message,
    event.evidence_bundle_path ? `Evidence: ${event.evidence_bundle_path}` : null,
    guidanceMap[code] || 'Inspect the latest job details before retrying.'
  ].filter(Boolean).join('\n');
}

export function formatTelegramJobResultMessage(event) {
  const payload = event.payload || {};
  const statusLabel = event.event_type === 'job_success'
    ? '✅ Job succeeded'
    : (event.event_type === 'job_blocked' ? '⛔ Job blocked' : '❌ Job failed');

  return [
    statusLabel,
    event.candidate_id ? `Candidate: ${event.candidate_id}` : null,
    event.job_id ? `Job: ${event.job_id}` : null,
    event.post_url ? `Post: ${truncateText(event.post_url, 500)}` : null,
    formatTelegramResultReason(event, payload)
  ].filter(Boolean).join('\n');
}

export function buildTelegramResultNotificationBatches(events, options = {}) {
  const maxMessageLength = Math.max(80, Math.trunc(Number(options.maxMessageLength) || DEFAULT_MAX_MESSAGE_LENGTH));
  const blocks = (events || [])
    .filter((event) => event && TERMINAL_JOB_EVENT_TYPE_SET.has(event.event_type))
    .map((event) => ({
      eventId: event.id,
      message: formatTelegramJobResultMessage(event)
    }));

  if (!blocks.length) return [];

  const notifications = [];
  let currentMessage = '';
  let currentLastEventId = null;
  let currentEventCount = 0;

  for (const block of blocks) {
    if (!currentMessage) {
      currentMessage = block.message;
      currentLastEventId = block.eventId;
      currentEventCount = 1;
      continue;
    }

    const combined = `${currentMessage}\n\n${block.message}`;
    if (combined.length <= maxMessageLength) {
      currentMessage = combined;
      currentLastEventId = block.eventId;
      currentEventCount += 1;
      continue;
    }

    notifications.push({
      message: currentMessage,
      lastEventId: currentLastEventId,
      eventCount: currentEventCount
    });
    currentMessage = block.message;
    currentLastEventId = block.eventId;
    currentEventCount = 1;
  }

  if (currentMessage) {
    notifications.push({
      message: currentMessage,
      lastEventId: currentLastEventId,
      eventCount: currentEventCount
    });
  }

  return notifications;
}

export function buildTelegramResultNotifications(events, options = {}) {
  return buildTelegramResultNotificationBatches(events, options).map((batch) => batch.message);
}

export function initializeTelegramResultCursor(db) {
  const existingCursor = readTelegramResultCursor(db);
  if (existingCursor !== null) return existingCursor;
  const latestId = getLatestTelegramResultEventId(db);
  writeTelegramResultCursor(db, latestId);
  return latestId;
}

export { TERMINAL_JOB_EVENT_TYPES };
