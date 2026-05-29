/**
 * @typedef {Object} ReviewReadPendingInput
 * @property {number=} limit
 */

/**
 * @typedef {Object} ReviewPendingItem
 * @property {number} candidateId
 * @property {string} postUrl
 */

/**
 * @typedef {Object} ReviewReadDeps
 * @property {(sql:string, params?:any[]) => any[]} runReadQuery
 */

/**
 * @typedef {Object} ReviewReadPendingOk
 * @property {'ok'} status
 * @property {number} limit
 * @property {ReviewPendingItem[]} items
 */

/**
 * @typedef {Object} ReviewReadPendingDegraded
 * @property {'degraded'} status
 * @property {'ROW_SHAPE_MISMATCH'} reason
 * @property {string} detail
 * @property {number} limit
 * @property {ReviewPendingItem[]} items
 */

/**
 * @typedef {Object} ReviewReadPendingError
 * @property {'error'} status
 * @property {string} code
 * @property {string} message
 * @property {string=} detail
 */

/**
 * Side effects:
 * - Read-only SQL query via injected runReadQuery
 * - No DB writes, no file writes, no network calls
 *
 * @param {ReviewReadPendingInput} input
 * @param {ReviewReadDeps} deps
 * @returns {ReviewReadPendingOk | ReviewReadPendingDegraded | ReviewReadPendingError}
 */
/**
export function reviewDecisionResult(status, extras = {}) {
  return { status, ...extras };
}

/**
 * @typedef {Object} ReviewReadQueueInput
 * @property {number=} limit
 */

/**
 * @typedef {Object} ReviewQueueItem
 * @property {number} jobId
 * @property {number} candidateId
 * @property {string} status
 * @property {string} postUrl
 * @property {string} createdAt
 */

/**
 * @typedef {Object} ReviewReadQueueOk
 * @property {'ok'} status
 * @property {number} limit
 * @property {ReviewQueueItem[]} items
 */

/**
 * @typedef {Object} ReviewReadQueueDegraded
 * @property {'degraded'} status
 * @property {'ROW_SHAPE_MISMATCH'} reason
 * @property {string} detail
 * @property {number} limit
 * @property {ReviewQueueItem[]} items
 */

/**
 * @typedef {Object} ReviewReadQueueError
 * @property {'error'} status
 * @property {string} code
 * @property {string} message
 * @property {string=} detail
 */

/**
 * Side effects:
 * - Read-only SQL query via injected runReadQuery
 * - No DB writes, no file writes, no network calls
 *
 * @param {ReviewReadQueueInput} input
 * @param {ReviewReadDeps} deps
 * @returns {ReviewReadQueueOk | ReviewReadQueueDegraded | ReviewReadQueueError}
 */
export function readReviewQueue(input = {}, deps) {
  if (typeof deps?.runReadQuery !== 'function') {
    return { status: 'error', code: 'INVALID_DEPS', message: 'runReadQuery dependency is required' };
  }

  const rawLimit = Number.isFinite(Number(input.limit)) ? Number(input.limit) : 5;
  const limit = Math.max(1, Math.trunc(rawLimit || 5));

  let rows;
  try {
    rows = deps.runReadQuery(
      `SELECT lj.id, lj.candidate_id, lj.status, c.post_url, lj.created_at
       FROM like_jobs lj
       JOIN candidates c ON c.id = lj.candidate_id
       WHERE lj.status = 'queued'
       ORDER BY lj.id DESC
       LIMIT ?`,
      [limit]
    );
  } catch (err) {
    return {
      status: 'error',
      code: 'DB_QUERY_FAILED',
      message: 'Review-queue query failed',
      detail: err?.message || String(err)
    };
  }

  const items = [];
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    if (!r || typeof r.id !== 'number' || typeof r.candidate_id !== 'number' || typeof r.status !== 'string' || typeof r.post_url !== 'string' || typeof r.created_at !== 'string') {
      return {
        status: 'degraded',
        reason: 'ROW_SHAPE_MISMATCH',
        detail: `Invalid row shape at index ${i}`,
        limit,
        items
      };
    }
    items.push({
      jobId: r.id,
      candidateId: r.candidate_id,
      status: r.status,
      postUrl: r.post_url,
      createdAt: r.created_at
    });
  }

  return { status: 'ok', limit, items };
}

/**
 * @typedef {Object} ReviewReadHistoryInput
 * @property {number=} limit
 */

/**
 * @typedef {Object} ReviewHistoryItem
 * @property {number} approvalId
 * @property {number} candidateId
 * @property {'approved'|'skipped'} decision
 * @property {string} decidedBy
 * @property {string} decidedAt
 */

/**
 * @typedef {Object} ReviewReadHistoryOk
 * @property {'ok'} status
 * @property {number} limit
 * @property {ReviewHistoryItem[]} items
 */

/**
 * @typedef {Object} ReviewReadHistoryDegraded
 * @property {'degraded'} status
 * @property {'ROW_SHAPE_MISMATCH'} reason
 * @property {string} detail
 * @property {number} limit
 * @property {ReviewHistoryItem[]} items
 */

/**
 * @typedef {Object} ReviewReadHistoryError
 * @property {'error'} status
 * @property {string} code
 * @property {string} message
 * @property {string=} detail
 */

/**
 * Side effects:
 * - Read-only SQL query via injected runReadQuery
 * - No DB writes, no file writes, no network calls
 *
 * @param {ReviewReadHistoryInput} input
 * @param {ReviewReadDeps} deps
 * @returns {ReviewReadHistoryOk | ReviewReadHistoryDegraded | ReviewReadHistoryError}
 */
export function readReviewHistory(input = {}, deps) {
  if (typeof deps?.runReadQuery !== 'function') {
    return { status: 'error', code: 'INVALID_DEPS', message: 'runReadQuery dependency is required' };
  }
  const rawLimit = Number.isFinite(Number(input.limit)) ? Number(input.limit) : 25;
  const limit = Math.max(1, Math.trunc(rawLimit || 25));

  let rows;
  try {
    rows = deps.runReadQuery(
      `SELECT a.id, a.candidate_id, a.decision, a.decided_by, a.decided_at
       FROM approvals a
       ORDER BY a.id DESC
       LIMIT ?`,
      [limit]
    );
  } catch (err) {
    return { status: 'error', code: 'DB_QUERY_FAILED', message: 'Review-history query failed', detail: err?.message || String(err) };
  }

  const items = [];
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    if (!r || typeof r.id !== 'number' || typeof r.candidate_id !== 'number' || (r.decision !== 'approved' && r.decision !== 'skipped') || typeof r.decided_by !== 'string' || typeof r.decided_at !== 'string') {
      return { status: 'degraded', reason: 'ROW_SHAPE_MISMATCH', detail: `Invalid row shape at index ${i}`, limit, items };
    }
    items.push({ approvalId: r.id, candidateId: r.candidate_id, decision: r.decision, decidedBy: r.decided_by, decidedAt: r.decided_at });
  }

  return { status: 'ok', limit, items };
}

export function readReviewPending(input = {}, deps) {
  if (typeof deps?.runReadQuery !== 'function') {
    return { status: 'error', code: 'INVALID_DEPS', message: 'runReadQuery dependency is required' };
  }

  const rawLimit = Number.isFinite(Number(input.limit)) ? Number(input.limit) : 5;
  const limit = Math.max(1, Math.trunc(rawLimit || 5));

  let rows;
  try {
    rows = deps.runReadQuery(
      `SELECT c.id, c.post_url
       FROM candidates c
       LEFT JOIN approvals a ON a.candidate_id = c.id
       WHERE a.id IS NULL
       ORDER BY c.created_at ASC
       LIMIT ?`,
      [limit]
    );
  } catch (err) {
    return {
      status: 'error',
      code: 'DB_QUERY_FAILED',
      message: 'Pending-review query failed',
      detail: err?.message || String(err)
    };
  }

  const items = [];
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    if (!r || typeof r.id !== 'number' || typeof r.post_url !== 'string') {
      return {
        status: 'degraded',
        reason: 'ROW_SHAPE_MISMATCH',
        detail: `Invalid row shape at index ${i}`,
        limit,
        items
      };
    }
    items.push({ candidateId: r.id, postUrl: r.post_url });
  }

  return { status: 'ok', limit, items };
}
