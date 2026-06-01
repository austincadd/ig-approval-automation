import 'dotenv/config';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';
import { CHALLENGE_SELECTORS, detectChallengeFromSignals } from './safety.js';
import { waitForPrimaryActionControlWithRetry } from './selectors.js';
import { classifyPageShape, PAGE_SHAPES } from './page-shape.js';
import { verifyLikeAction } from './verification.js';
import { logEvent } from './logger.js';
import { claimNextQueuedJob, pauseAutomation } from '../core/recovery.js';
import { launchBrowserSessionWithPreflight } from '../core/browser-profile.js';
import { installTimestampedConsole } from '../scripts/lib/timestamped-console.js';
import { runExecutorCanary } from '../core/canary.js';
import { classifyFailure, applyFailurePolicy } from '../core/failure-policy.js';
import { createEvidenceBundle } from '../core/evidence-bundles.js';
import { recordSessionChallenge, recordSessionLogout, recordSuccessfulAction, setSessionQuarantine } from '../core/session-state.js';
import { getPolicyVersions } from '../core/policy-versions.js';
import { getOperatorAutomationStatus } from '../core/automation-status.js';
import { evaluateReadiness } from '../core/readiness.js';

installTimestampedConsole();

const defaultDbPath = path.resolve(process.env.IG_AUTOMATION_DB_PATH || 'data/ig_automation.db');
const defaultProfileDir = process.env.IG_BROWSER_PROFILE_DIR || '.browser-profile';
const MAX_ERROR_MESSAGE_LENGTH = 1800;

function createDb(dbPath = defaultDbPath) {
  return new Database(dbPath);
}

function flag(db, key) {
  return db.prepare('SELECT value FROM system_flags WHERE key=?').get(key)?.value;
}

function overLimit(db) {
  const daily = Number(flag(db, 'DAILY_LIMIT') || 10);
  const hourly = Number(flag(db, 'HOURLY_LIMIT') || 3);
  const d = db.prepare("SELECT COUNT(*) c FROM like_jobs WHERE status='success' AND datetime(finished_at) > datetime('now','-1 day')").get().c;
  const h = db.prepare("SELECT COUNT(*) c FROM like_jobs WHERE status='success' AND datetime(finished_at) > datetime('now','-1 hour')").get().c;
  return d >= daily || h >= hourly;
}

function limitText(value, maxLength = MAX_ERROR_MESSAGE_LENGTH) {
  if (!value) return null;
  const text = String(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function compactDiagnostics(value, maxLength = 1000) {
  const json = safeJson(value);
  if (!json) return null;
  return limitText(json, maxLength);
}

function buildPersistedErrorMessage(err) {
  const base = limitText(err?.message || String(err) || 'Unknown error');
  const diagnostics = compactDiagnostics(err?.persistedDiagnostics);
  if (!diagnostics) return base;
  return limitText(`${base} | diagnostics=${diagnostics}`);
}

function finish(db, jobId, status, err = null, outcome = {}) {
  db.prepare(`
    UPDATE like_jobs
    SET status=?,
        finished_at=datetime('now'),
        updated_at=datetime('now'),
        error_code=?,
        error_message=?,
        failure_class=?,
        failure_policy=?,
        evidence_bundle_path=?,
        screenshot_path=?
    WHERE id=?
  `).run(
    status,
    err?.code || null,
    buildPersistedErrorMessage(err),
    outcome.failureClass || null,
    outcome.failurePolicy || null,
    outcome.evidenceBundlePath || null,
    outcome.screenshotPath || null,
    jobId
  );
}

function describeControl(descriptor) {
  if (!descriptor) return null;
  return `${descriptor.tag}[aria-label="${descriptor.aria}"] @ (${descriptor.x},${descriptor.y}) ${descriptor.w}x${descriptor.h}`;
}

function summarizeRow(row) {
  if (!row) return null;
  return {
    orientation: row.orientation,
    variant: row.variant,
    minX: row.minX,
    maxX: row.maxX,
    minY: row.minY,
    maxY: row.maxY,
    supportCount: row.supportCount,
    state: row.state,
    labels: [...row.labels]
  };
}

function summarizeCandidates(candidates = [], limit = 12) {
  return candidates.slice(0, limit).map((candidate) => ({
    index: candidate.index,
    tag: candidate.tag,
    aria: candidate.aria,
    x: candidate.x,
    y: candidate.y,
    w: candidate.w,
    h: candidate.h,
    visible: candidate.visible
  }));
}

function buildPrimaryControlFailureDiagnostics(result, pageShape = null) {
  return {
    attempts: result?.attempts || 1,
    state: result?.state || 'unknown',
    layoutFamily: result?.layoutFamily || 'unknown',
    pageShape: pageShape?.shape || null,
    pageShapeReason: pageShape?.reason || null,
    descriptor: result?.descriptor || null,
    row: summarizeRow(result?.row),
    candidateCount: result?.candidates?.length || 0,
    candidatesSample: summarizeCandidates(result?.candidates),
    diagnostics: result?.diagnostics || { rows: [], columns: [], fallbackCandidates: [] },
    firstAttemptCandidateCount: result?.firstAttemptCandidates?.length || 0,
    firstAttemptCandidatesSample: summarizeCandidates(result?.firstAttemptCandidates),
    firstAttemptDiagnostics: result?.firstAttemptDiagnostics || null
  };
}

async function getVisiblePageText(page) {
  return page.evaluate(() => document.body?.innerText || '').catch(() => '');
}

async function getChallengeSelectorHits(page) {
  const hits = [];
  for (const selector of CHALLENGE_SELECTORS) {
    const count = await page.locator(selector).count().catch(() => 0);
    if (count > 0) hits.push(selector);
  }
  return hits;
}

async function detectChallenge(page) {
  const url = page.url();
  const [visibleText, selectorHits] = await Promise.all([
    getVisiblePageText(page),
    getChallengeSelectorHits(page)
  ]);

  return detectChallengeFromSignals({ url, visibleText, selectorHits });
}

async function persistNonSuccessEvidence({ page, job, err, classifiedFailure }) {
  return createEvidenceBundle({
    page,
    jobId: job?.id,
    candidateId: job?.candidate_id,
    outcomeCode: err?.code,
    failureClass: classifiedFailure?.failureClass,
    classifiedFailure,
    diagnostics: {
      selectorDiagnostics: err?.verificationDiagnostics || err?.persistedDiagnostics || null,
      primaryControlCandidateMap: err?.persistedDiagnostics?.candidatesSample || null,
      challengeMarkers: err?.reason || err?.detail ? { reason: err?.reason, detail: err?.detail } : null,
      rawDiagnostics: err?.persistedDiagnostics || null
    }
  });
}

function makeFailure(code, message, extra = {}) {
  return { code, message, ...extra };
}

function retryPlanForFailureCode(code) {
  switch (code) {
    case 'LIKE_BUTTON_NOT_FOUND':
      return { allowed: true, reason: 'selector_alternate_strategy', waitMs: 350 };
    case 'LIKE_VERIFICATION_AMBIGUOUS':
      return { allowed: true, reason: 'verification_re_resolve', waitMs: 500 };
    case 'NETWORK_IDLE_TIMEOUT':
    case 'NAVIGATION_TIMEOUT':
      return { allowed: true, reason: 'transient_page_load', waitMs: 600 };
    default:
      return { allowed: false, reason: null, waitMs: 0 };
  }
}

async function performLikeAttempt(page, job, attemptNumber) {
  await page.goto(job.post_url, { waitUntil: 'domcontentloaded', timeout: 30000 });

  const pageShape = await classifyPageShape(page);
  if (pageShape.shape === PAGE_SHAPES.CHALLENGE) {
    throw makeFailure('CHECKPOINT_DETECTED', 'Challenge or security marker detected before like action. Automation paused.', {
      reason: pageShape.reason,
      detail: pageShape.detail,
      persistedDiagnostics: { pageShape }
    });
  }
  if (pageShape.shape === PAGE_SHAPES.UNAVAILABLE) {
    throw makeFailure('TARGET_UNAVAILABLE', 'Target post is unavailable or removed.', {
      reason: pageShape.reason,
      detail: pageShape.detail,
      persistedDiagnostics: { pageShape }
    });
  }
  if (pageShape.shape === PAGE_SHAPES.UNSUPPORTED) {
    throw makeFailure('TARGET_UNSUPPORTED_SHAPE', 'Target page shape is unsupported for automation.', {
      reason: pageShape.reason,
      detail: pageShape.detail,
      persistedDiagnostics: { pageShape }
    });
  }

  const primaryControl = await waitForPrimaryActionControlWithRetry(page, {
    timeoutMs: pageShape.shape === PAGE_SHAPES.REEL ? 5500 : 4500
  });

  if (!primaryControl.ok) {
    throw makeFailure('LIKE_BUTTON_NOT_FOUND', 'Could not locate primary like control after layered selector retry.', {
      attempts: primaryControl.attempts,
      persistedDiagnostics: buildPrimaryControlFailureDiagnostics(primaryControl, pageShape),
      pageShape
    });
  }

  const clickedSelector = describeControl(primaryControl.descriptor);
  const primaryRow = summarizeRow(primaryControl.row);

  if (primaryControl.state === 'liked') {
    return {
      done: true,
      status: 'success',
      outcome: 'already_liked',
      clickedSelector: null,
      verifiedSelector: clickedSelector,
      primaryRow,
      pageShape,
      attemptNumber
    };
  }

  await primaryControl.handle.click({ timeout: 8000 });

  const verification = await verifyLikeAction(page, {
    timeoutMs: pageShape.shape === PAGE_SHAPES.REEL ? 5500 : 4500,
    preClickDescriptor: primaryControl.descriptor,
    preClickState: primaryControl.state,
    detectChallenge
  });

  if (!verification.ok) {
    throw makeFailure(verification.code, 'Like click did not produce a confirmed liked state.', {
      clickedSelector,
      primaryRow,
      verificationRow: verification.row,
      verificationDiagnostics: {
        pageShape,
        selector: verification.selector,
        row: verification.row,
        signals: verification.signals,
        diagnostics: verification.diagnostics,
        cause: verification.cause,
        challenge: verification.challenge
      },
      persistedDiagnostics: {
        pageShape,
        clickedSelector,
        primaryRow,
        verification: {
          selector: verification.selector,
          row: verification.row,
          signals: verification.signals,
          diagnostics: verification.diagnostics,
          cause: verification.cause,
          challenge: verification.challenge
        }
      }
    });
  }

  return {
    done: true,
    status: 'success',
    outcome: 'clicked_and_verified',
    clickedSelector,
    verifiedSelector: verification.selector,
    primaryRow,
    verificationRow: verification.row,
    pageShape,
    attemptNumber
  };
}

async function executeJobWithRetries(db, page, job) {
  let attemptNumber = 1;
  let lastError = null;

  while (attemptNumber <= 2) {
    try {
      const result = await performLikeAttempt(page, job, attemptNumber);
      return result;
    } catch (error) {
      lastError = error;
      const plan = retryPlanForFailureCode(error.code);
      if (!plan.allowed || attemptNumber >= 2) break;

      logEvent(db, {
        jobId: job.id,
        level: 'warn',
        eventType: 'job_retry_planned',
        payload: {
          code: error.code,
          attemptNumber,
          retryAttemptNumber: attemptNumber + 1,
          retryReason: plan.reason,
          waitMs: plan.waitMs
        }
      });

      await page.waitForTimeout(plan.waitMs);
      attemptNumber += 1;
    }
  }

  throw lastError;
}

export async function run({
  db = null,
  chromiumImpl = chromium,
  browserSessionLauncher = launchBrowserSessionWithPreflight,
  profileDir = defaultProfileDir
} = {}) {
  const activeDb = db || createDb();
  const ownsDb = !db;

  try {
    if (String(flag(activeDb, 'AUTOMATION_ENABLED')).toLowerCase() !== 'true') return console.log('Automation paused');
    if (overLimit(activeDb)) return console.log('Rate limits reached');

    let browserSession;
    try {
      browserSession = await browserSessionLauncher({
        chromium: chromiumImpl,
        profileDir,
        owner: 'worker/run-once',
        lockTimeoutMs: 0,
        headless: false,
        navigationTimeoutMs: 30000
      });
    } catch (err) {
      if (err?.code === 'BROWSER_PROFILE_LOCKED') {
        const classifiedFailure = classifyFailure({ code: 'CANARY_PROFILE_LOCK_FAILED' });
        console.log(`Browser profile busy; worker skipped run (${err.lockOwner || 'unknown owner'}).`);
        return classifiedFailure;
      }
      if (err?.code === 'BROWSER_SESSION_NOT_READY') {
        pauseAutomation(activeDb, { actor: 'worker', reason: 'browser_session_preflight_failed' });
        console.error(`Browser session preflight failed: ${err.reason || err.message}`);
        return classifyFailure({ code: err.reason === 'CHALLENGE_URL' ? 'CANARY_CHALLENGE_DETECTED' : 'CANARY_NOT_LOGGED_IN', reason: err.reason, detail: err.detail });
      }
      throw err;
    }

    const { ctx, page, lock } = browserSession;

    try {
      const policyVersions = getPolicyVersions();
      const canary = await runExecutorCanary({ activeDb, db: activeDb, page, profileUrl: process.env.IG_CANARY_URL || 'https://www.instagram.com/' });
      if (!canary.ok) {
        if (canary.state === 'operator_required' || canary.state === 'unsafe') {
          pauseAutomation(activeDb, { actor: 'worker', reason: canary.code || 'executor_canary_failed' });
        }
        console.error(`Executor canary failed before claim: ${canary.code || canary.reason || 'unknown'}`);
        return;
      }

      const operatorStatus = getOperatorAutomationStatus(activeDb);
      const readiness = evaluateReadiness(activeDb, operatorStatus);
      if (!readiness.ok) {
        logEvent(activeDb, {
          level: readiness.state === 'unsafe' ? 'error' : 'warn',
          eventType: 'worker_readiness_blocked',
          payload: {
            readiness,
            policyVersions
          }
        });
        if (readiness.state === 'unsafe') {
          pauseAutomation(activeDb, { actor: 'worker', reason: 'worker_readiness_unsafe' });
        }
        console.error(`Worker readiness blocked before claim: ${readiness.state}`);
        return;
      }

      const job = claimNextQueuedJob(activeDb);
      if (!job) {
        return console.log('No queued jobs');
      }

      try {
        logEvent(activeDb, { jobId: job.id, eventType: 'job_started', payload: { url: job.post_url, claimMode: 'transactional', canaryState: canary.state, canaryStartedAt: canary.startedAt, policyVersions } });
        const result = await executeJobWithRetries(activeDb, page, job);

        finish(activeDb, job.id, result.status);
        logEvent(activeDb, {
          jobId: job.id,
          eventType: 'job_success',
          payload: {
            url: job.post_url,
            pageShape: result.pageShape?.shape || null,
            pageShapeReason: result.pageShape?.reason || null,
            clickedSelector: result.clickedSelector,
            verifiedSelector: result.verifiedSelector,
            primaryRow: result.primaryRow,
            verificationRow: result.verificationRow || null,
            attemptNumber: result.attemptNumber,
            outcome: result.outcome,
            policyVersions
          }
        });
        recordSuccessfulAction(activeDb, { metadata: { jobId: job.id, candidateId: job.candidate_id, postUrl: job.post_url, pageShape: result.pageShape?.shape || null } });
        console.log(`Success job ${job.id}`);
      } catch (e) {
        const blocked = e.code === 'CHECKPOINT_DETECTED';
        const classifiedFailure = applyFailurePolicy(activeDb, classifyFailure({ code: e.code, reason: e.reason, detail: e.detail }), {
          actor: 'worker',
          jobId: job.id,
          candidateId: job.candidate_id
        });
        if (classifiedFailure.policy === 'pause_whole_system' || classifiedFailure.policy === 'require_operator_action' || classifiedFailure.policy === 'pause_executor') {
          pauseAutomation(activeDb, { actor: 'worker', reason: classifiedFailure.code });
        }
        if (e.code === 'CHECKPOINT_DETECTED') {
          recordSessionChallenge(activeDb, { reason: classifiedFailure.code || e.code, metadata: { jobId: job.id, candidateId: job.candidate_id, postUrl: job.post_url } });
        } else if (e.code === 'CANARY_NOT_LOGGED_IN') {
          recordSessionLogout(activeDb, { reason: classifiedFailure.code || e.code, metadata: { jobId: job.id, candidateId: job.candidate_id, postUrl: job.post_url } });
        } else if (classifiedFailure.policy === 'pause_executor' || classifiedFailure.policy === 'require_operator_action') {
          setSessionQuarantine(activeDb, { sessionHealth: 'degraded', reason: classifiedFailure.code || e.code, metadata: { jobId: job.id, candidateId: job.candidate_id, postUrl: job.post_url } });
        }
        const evidence = await persistNonSuccessEvidence({ page, job, err: e, classifiedFailure });
        finish(activeDb, job.id, blocked ? 'blocked' : 'failed', e, {
          failureClass: classifiedFailure.failureClass,
          failurePolicy: classifiedFailure.policy,
          evidenceBundlePath: evidence.bundleDir,
          screenshotPath: evidence.screenshotPath
        });
        logEvent(activeDb, {
          jobId: job.id,
          level: 'error',
          eventType: blocked ? 'job_blocked' : 'job_failed',
          payload: {
            error: {
              code: e.code,
              message: e.message || String(e),
              failureClass: classifiedFailure.failureClass,
              policy: classifiedFailure.policy,
              policyVersions
            },
            evidenceBundlePath: evidence.bundleDir,
            screenshotPath: evidence.screenshotPath
          }
        });
        console.error(`Failed job ${job.id}: ${e.message || e}`);
      }
    } finally {
      await ctx.close().catch(() => {});
      lock.release();
    }
  } finally {
    if (ownsDb) activeDb.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
