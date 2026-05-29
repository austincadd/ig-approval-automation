import fs from 'node:fs';

/**
 * @typedef {{ref:string, limit?:number}} CandidatesBuildInput
 * @typedef {{runCommand:(cmd:string,args:string[])=>({stdout:string}|Promise<{stdout:string}>), resetState:()=>void, candidatesFile:string, readJsonFile:(absPath:string)=>any}} CandidatesBuildDeps
 */

export async function buildCandidates(input = {}, deps) {
  const ref = String(input?.ref || '').trim();
  const limit = Number.isFinite(Number(input?.limit)) ? Math.max(1, Math.trunc(Number(input.limit))) : 0;
  if (!ref) return { status: 'error', code: 'INVALID_INPUT', message: 'ref is required' };
  if (typeof deps?.runCommand !== 'function' || typeof deps?.resetState !== 'function' || !deps?.candidatesFile || typeof deps?.readJsonFile !== 'function') {
    return { status: 'error', code: 'INVALID_DEPS', message: 'runCommand/resetState/candidatesFile/readJsonFile are required' };
  }

  const args = ['scripts/build-ig-candidates.js', ref];
  if (limit > 0) args.push(String(limit));

  let out = '';
  try {
    out = String((await deps.runCommand('node', args))?.stdout || '');
  } catch (err) {
    return { status: 'error', code: 'BUILD_FAILED', message: 'Candidate build failed', detail: err?.stderr?.toString?.() || err?.message || String(err), ref, limit };
  }

  try { deps.resetState(); } catch {}

  if (!fs.existsSync(deps.candidatesFile)) {
    return { status: 'degraded', ref, limit, generatedFile: deps.candidatesFile, stateReset: true, reason: 'RESULT_MISSING', detail: 'Build completed but candidates file missing' };
  }

  let doc;
  try { doc = deps.readJsonFile(deps.candidatesFile); } catch (err) {
    return { status: 'degraded', ref, limit, generatedFile: deps.candidatesFile, stateReset: true, reason: 'RESULT_UNREADABLE', detail: err?.message || String(err) };
  }

  return {
    status: 'ok',
    ref,
    limit,
    generatedFile: deps.candidatesFile,
    count: Number(doc?.count ?? (Array.isArray(doc?.candidates) ? doc.candidates.length : 0)),
    source: String(doc?.candidate_source || 'unknown'),
    stateReset: true
  };
}

/**
 * @typedef {Object} CandidatesTopInput
 * @property {string=} tier
 * @property {number=} limit
 */

/**
 * @typedef {Object} CandidatesTopItem
 * @property {number} rank
 * @property {string} key
 * @property {string} username
 * @property {string} tier
 * @property {string} likeTier
 * @property {string} commentTier
 * @property {number} score
 */

/**
 * @typedef {Object} CandidatesTopDeps
 * @property {(absPath:string) => any} readJsonFile
 * @property {string} candidatesFile
 */

/**
 * @typedef {Object} CandidatesTopOk
 * @property {'ok'} status
 * @property {number} limit
 * @property {string|null} tierFilter
 * @property {number} total
 * @property {number} filteredTotal
 * @property {CandidatesTopItem[]} items
 */

/**
 * @typedef {Object} CandidatesTopDegraded
 * @property {'degraded'} status
 * @property {number} limit
 * @property {string|null} tierFilter
 * @property {'ROW_SHAPE_MISMATCH'} reason
 * @property {string} detail
 * @property {number} total
 * @property {number} filteredTotal
 * @property {CandidatesTopItem[]} items
 */

/**
 * @typedef {Object} CandidatesTopError
 * @property {'error'} status
 * @property {string} code
 * @property {string} message
 * @property {string=} detail
 */

/**
 * Side effects:
 * - Read-only file access to data/ig-candidates.json
 * - No DB writes, no process spawn, no network calls
 *
 * @param {CandidatesTopInput} input
 * @param {CandidatesTopDeps} deps
 * @returns {CandidatesTopOk | CandidatesTopDegraded | CandidatesTopError}
 */
export async function buildCandidatesFromComments(input = {}, deps) {
  const username = String(input?.username || '').trim();
  const candidateLimit = Number.isFinite(Number(input?.candidateLimit)) ? Math.max(1, Math.trunc(Number(input.candidateLimit))) : 30;
  const postCount = Number.isFinite(Number(input?.postCount)) ? Math.max(1, Math.trunc(Number(input.postCount))) : 3;
  if (!username) return { status: 'error', code: 'INVALID_INPUT', message: 'username is required' };
  if (typeof deps?.runCommand !== 'function' || typeof deps?.resetState !== 'function' || !deps?.candidatesFile || typeof deps?.readJsonFile !== 'function') {
    return { status: 'error', code: 'INVALID_DEPS', message: 'runCommand/resetState/candidatesFile/readJsonFile are required' };
  }

  try {
    await deps.runCommand('node', ['scripts/build-ig-candidates-from-comments.js', username, String(candidateLimit), String(postCount)]);
  } catch (err) {
    return { status: 'error', code: 'BUILD_FAILED', message: 'Commenter candidate build failed', detail: err?.stderr?.toString?.() || err?.message || String(err), username, candidateLimit, postCount };
  }

  try { deps.resetState(); } catch {}

  if (!fs.existsSync(deps.candidatesFile)) {
    return { status: 'degraded', username, candidateLimit, postCount, generatedFile: deps.candidatesFile, stateReset: true, reason: 'RESULT_MISSING', detail: 'Build completed but candidates file missing' };
  }

  let doc;
  try { doc = deps.readJsonFile(deps.candidatesFile); } catch (err) {
    return { status: 'degraded', username, candidateLimit, postCount, generatedFile: deps.candidatesFile, stateReset: true, reason: 'RESULT_UNREADABLE', detail: err?.message || String(err) };
  }

  return {
    status: 'ok',
    username,
    candidateLimit,
    postCount,
    stateReset: true,
    generatedFile: deps.candidatesFile,
    count: Number(doc?.count ?? (Array.isArray(doc?.candidates) ? doc.candidates.length : 0)),
    source: String(doc?.candidate_source || 'unknown')
  };
}

export async function buildCandidatesFused(input = {}, deps) {
  const username = String(input?.username || '').trim();
  const candidateLimit = Number.isFinite(Number(input?.candidateLimit)) ? Math.max(1, Math.trunc(Number(input.candidateLimit))) : 40;
  const postCount = Number.isFinite(Number(input?.postCount)) ? Math.max(1, Math.trunc(Number(input.postCount))) : 3;
  if (!username) return { status: 'error', code: 'INVALID_INPUT', message: 'username is required' };
  if (typeof deps?.runCommand !== 'function' || typeof deps?.resetState !== 'function' || !deps?.candidatesFile || typeof deps?.readJsonFile !== 'function') {
    return { status: 'error', code: 'INVALID_DEPS', message: 'runCommand/resetState/candidatesFile/readJsonFile are required' };
  }

  try {
    await deps.runCommand('node', ['scripts/build-ig-candidates-fused.js', username, String(candidateLimit), String(postCount)]);
  } catch (err) {
    return { status: 'error', code: 'BUILD_FAILED', message: 'Fused candidate build failed', detail: err?.stderr?.toString?.() || err?.message || String(err), username, candidateLimit, postCount };
  }

  try { deps.resetState(); } catch {}

  if (!fs.existsSync(deps.candidatesFile)) {
    return { status: 'degraded', username, candidateLimit, postCount, generatedFile: deps.candidatesFile, stateReset: true, reason: 'RESULT_MISSING', detail: 'Build completed but candidates file missing' };
  }

  let doc;
  try { doc = deps.readJsonFile(deps.candidatesFile); } catch (err) {
    return { status: 'degraded', username, candidateLimit, postCount, generatedFile: deps.candidatesFile, stateReset: true, reason: 'RESULT_UNREADABLE', detail: err?.message || String(err) };
  }

  return {
    status: 'ok',
    username,
    candidateLimit,
    postCount,
    stateReset: true,
    generatedFile: deps.candidatesFile,
    count: Number(doc?.count ?? (Array.isArray(doc?.candidates) ? doc.candidates.length : 0)),
    source: String(doc?.candidate_source || 'unknown'),
    tierCounts: doc?.tier_counts,
    likeTierCounts: doc?.like_tier_counts,
    commentTierCounts: doc?.comment_tier_counts
  };
}

export function getCandidatesTop(input = {}, deps) {
  const rawTier = typeof input.tier === 'string' ? input.tier.trim().toUpperCase() : '';
  const tierFilter = rawTier && ['A', 'B', 'C'].includes(rawTier) ? rawTier : null;

  const rawLimit = Number.isFinite(Number(input.limit)) ? Number(input.limit) : 10;
  const limit = Math.min(Math.max(Math.trunc(rawLimit || 10), 1), 25);

  if (!deps?.candidatesFile) {
    return { status: 'error', code: 'INVALID_DEPS', message: 'candidatesFile dependency is required' };
  }

  if (!fs.existsSync(deps.candidatesFile)) {
    return { status: 'error', code: 'CANDIDATES_DOC_MISSING', message: 'Candidate document not found' };
  }

  let doc;
  try {
    doc = deps.readJsonFile(deps.candidatesFile);
  } catch (err) {
    return {
      status: 'error',
      code: 'CANDIDATES_DOC_INVALID',
      message: 'Candidate document could not be parsed',
      detail: err?.message || String(err)
    };
  }

  const candidates = Array.isArray(doc?.candidates) ? doc.candidates : [];
  const total = candidates.length;

  const filtered = tierFilter
    ? candidates.filter((c) => (c?.tier || 'C') === tierFilter)
    : candidates;

  const mapped = [];
  for (let i = 0; i < Math.min(filtered.length, limit); i += 1) {
    const c = filtered[i];
    if (!c || typeof c.username !== 'string' || typeof c.key !== 'string') {
      return {
        status: 'degraded',
        limit,
        tierFilter,
        reason: 'ROW_SHAPE_MISMATCH',
        detail: `Invalid candidate row at index ${i}`,
        total,
        filteredTotal: filtered.length,
        items: mapped
      };
    }

    mapped.push({
      rank: i + 1,
      key: c.key,
      username: c.username,
      tier: c.tier || 'C',
      likeTier: c.like_tier || 'C',
      commentTier: c.comment_tier || 'C',
      score: c.score ?? 0
    });
  }

  return {
    status: 'ok',
    limit,
    tierFilter,
    total,
    filteredTotal: filtered.length,
    items: mapped
  };
}

/**
 * @typedef {Object} CandidatesSourceInput
 */

/**
 * @typedef {Object} CandidatesSourceDeps
 * @property {(absPath:string) => any} readJsonFile
 * @property {string} candidatesFile
 */

/**
 * @typedef {Object} CandidatesSourceData
 * @property {string|null} inputRef
 * @property {string|null} sourceUserId
 * @property {string|null} sourceUsername
 * @property {string|null} candidateSource
 * @property {number} count
 * @property {{A:number,B:number,C:number}=} tierCounts
 * @property {{A:number,B:number,C:number}=} likeTierCounts
 * @property {{A:number,B:number,C:number}=} commentTierCounts
 * @property {string|null} generatedAt
 */

/**
 * @typedef {Object} CandidatesSourceOk
 * @property {'ok'} status
 * @property {CandidatesSourceData} data
 */

/**
 * @typedef {Object} CandidatesSourceDegraded
 * @property {'degraded'} status
 * @property {'MISSING_OPTIONAL_FIELDS'} reason
 * @property {string} detail
 * @property {CandidatesSourceData} data
 */

/**
 * @typedef {Object} CandidatesSourceError
 * @property {'error'} status
 * @property {string} code
 * @property {string} message
 * @property {string=} detail
 */

/**
 * Side effects:
 * - Read-only file access to data/ig-candidates.json
 * - No DB writes, no process spawn, no network calls
 *
 * @param {CandidatesSourceInput} _input
 * @param {CandidatesSourceDeps} deps
 * @returns {CandidatesSourceOk | CandidatesSourceDegraded | CandidatesSourceError}
 */
export function getCandidatesSource(_input = {}, deps) {
  if (!deps?.candidatesFile) {
    return { status: 'error', code: 'INVALID_DEPS', message: 'candidatesFile dependency is required' };
  }

  if (!fs.existsSync(deps.candidatesFile)) {
    return { status: 'error', code: 'CANDIDATES_DOC_MISSING', message: 'Candidate document not found' };
  }

  let doc;
  try {
    doc = deps.readJsonFile(deps.candidatesFile);
  } catch (err) {
    return {
      status: 'error',
      code: 'CANDIDATES_DOC_INVALID',
      message: 'Candidate document could not be parsed',
      detail: err?.message || String(err)
    };
  }

  const data = {
    inputRef: doc?.input_ref ?? null,
    sourceUserId: doc?.source_user_id ?? null,
    sourceUsername: doc?.source_username ?? null,
    candidateSource: doc?.candidate_source ?? null,
    count: Number(doc?.count ?? 0),
    tierCounts: doc?.tier_counts,
    likeTierCounts: doc?.like_tier_counts,
    commentTierCounts: doc?.comment_tier_counts,
    generatedAt: doc?.generated_at ?? null
  };

  if (data.tierCounts && data.likeTierCounts && data.commentTierCounts) {
    return { status: 'ok', data };
  }

  return {
    status: 'degraded',
    reason: 'MISSING_OPTIONAL_FIELDS',
    detail: 'One or more tier count groups are missing from candidate document.',
    data
  };
}
