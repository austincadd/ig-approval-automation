import path from 'node:path';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';
import { classifyPageShape } from '../worker/page-shape.js';
import { readAccountSessionState } from './session-state.js';
import { readExecutorCanaryResult } from './canary.js';
import { getPolicyVersions } from './policy-versions.js';
import { runSyntheticChecks } from './synthetic-checks.js';

function safeJsonParse(value) {
  try { return value ? JSON.parse(value) : null; } catch { return null; }
}

function writeResult(db, result) {
  const checkedAt = result.checkedAt || new Date().toISOString();
  const payload = {
    ...result,
    checkedAt,
    policyVersions: result.policyVersions || getPolicyVersions()
  };

  db.prepare(`
    INSERT INTO self_test_results(test_key, status, summary, details_json, checked_at, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(test_key) DO UPDATE SET
      status=excluded.status,
      summary=excluded.summary,
      details_json=excluded.details_json,
      checked_at=excluded.checked_at,
      updated_at=datetime('now')
  `).run(payload.testKey, payload.status, payload.summary || null, JSON.stringify(payload.details || {}), checkedAt);

  db.prepare(`
    INSERT INTO run_events(level, event_type, payload_json)
    VALUES (?, 'self_test_result', json(?))
  `).run(payload.status === 'ok' ? 'info' : (payload.status === 'skipped' ? 'warn' : 'error'), JSON.stringify(payload));

  return payload;
}

export function readSelfTestResults(db) {
  return db.prepare(`
    SELECT test_key, status, summary, details_json, checked_at, updated_at
    FROM self_test_results
    ORDER BY test_key ASC
  `).all().map((row) => ({
    testKey: row.test_key,
    status: row.status,
    summary: row.summary,
    details: safeJsonParse(row.details_json) || {},
    checkedAt: row.checked_at,
    updatedAt: row.updated_at
  }));
}

export function summarizeSelfTests(results = []) {
  const counts = { ok: 0, degraded: 0, error: 0, skipped: 0 };
  for (const row of results) counts[row.status] = (counts[row.status] || 0) + 1;
  const overall = counts.error > 0 ? 'error' : counts.degraded > 0 ? 'degraded' : counts.ok > 0 ? 'ok' : 'unknown';
  return { overall, counts, total: results.length };
}

async function runControlPlaneHttpTest(_db, options = {}) {
  const url = options.controlPlaneStatusUrl || process.env.IG_SELF_TEST_CONTROL_PLANE_URL || 'http://127.0.0.1:8788/automation/status';
  try {
    const response = await fetch(url, { method: 'GET' });
    return {
      testKey: 'control_plane_http',
      status: response.ok ? 'ok' : 'degraded',
      summary: response.ok ? `HTTP ${response.status}` : `HTTP ${response.status}`,
      details: { url, httpStatus: response.status, ok: response.ok }
    };
  } catch (error) {
    return {
      testKey: 'control_plane_http',
      status: 'degraded',
      summary: error?.message || 'fetch_failed',
      details: { url, error: error?.message || String(error) }
    };
  }
}

function runTelegramTransportTest(db) {
  const transport = safeJsonParse(db.prepare(`SELECT value FROM system_flags WHERE key='TELEGRAM_TRANSPORT_HEALTH'`).get()?.value) || {};
  const status = transport.duplicatePollerDetected ? 'error' : ((transport.status && transport.status !== 'ok') ? 'degraded' : 'ok');
  return {
    testKey: 'telegram_transport',
    status,
    summary: transport.lastError || transport.status || 'no transport issues recorded',
    details: transport
  };
}

function runDbIntegrityTest(db) {
  const orphanJobs = db.prepare(`
    SELECT COUNT(*) AS count
    FROM like_jobs lj
    LEFT JOIN candidates c ON c.id = lj.candidate_id
    WHERE c.id IS NULL
  `).get().count;
  const duplicateQueued = db.prepare(`
    SELECT COUNT(*) AS count FROM (
      SELECT candidate_id
      FROM like_jobs
      WHERE status IN ('queued','running')
      GROUP BY candidate_id
      HAVING COUNT(*) > 1
    )
  `).get().count;
  const badStatuses = db.prepare(`
    SELECT COUNT(*) AS count
    FROM like_jobs
    WHERE status NOT IN ('queued','running','success','failed','blocked','stopped')
  `).get().count;
  const status = orphanJobs || duplicateQueued || badStatuses ? 'error' : 'ok';
  return {
    testKey: 'db_integrity',
    status,
    summary: status === 'ok' ? 'queue + relational integrity look sane' : 'integrity anomaly detected',
    details: { orphanJobs, duplicateQueued, badStatuses }
  };
}

function runSessionCanaryReadOnlyTest(db) {
  const sessionState = readAccountSessionState(db);
  const canary = readExecutorCanaryResult(db);
  let status = 'ok';
  if (sessionState.sessionHealth === 'challenge' || sessionState.sessionHealth === 'logged_out') status = 'error';
  else if (sessionState.quarantineState !== 'clear' || (canary && canary.ok === false)) status = 'degraded';
  return {
    testKey: 'session_canary_readonly',
    status,
    summary: canary?.code || sessionState.sessionHealth || 'unknown',
    details: { sessionState, canary }
  };
}

async function runInstagramPageShapeProbe(_db, options = {}) {
  const enabled = String(options.enableBrowserProbe ?? process.env.IG_SELF_TEST_ENABLE_BROWSER ?? 'false').toLowerCase() === 'true';
  const targetUrl = options.pageShapeProbeUrl || process.env.IG_SELF_TEST_PAGE_SHAPE_URL || process.env.IG_CANARY_URL || 'https://www.instagram.com/';
  if (!enabled) {
    return {
      testKey: 'instagram_page_shape_probe',
      status: 'skipped',
      summary: 'browser probe disabled',
      details: { targetUrl, enabled }
    };
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const shape = await classifyPageShape(page);
    const status = shape.shape === 'challenge' ? 'error' : (shape.shape === 'unsupported' ? 'degraded' : 'ok');
    return {
      testKey: 'instagram_page_shape_probe',
      status,
      summary: `${shape.shape}:${shape.reason || 'n/a'}`,
      details: { targetUrl, shape }
    };
  } catch (error) {
    return {
      testKey: 'instagram_page_shape_probe',
      status: 'degraded',
      summary: error?.message || 'probe_failed',
      details: { targetUrl, error: error?.message || String(error) }
    };
  } finally {
    await browser?.close().catch(() => {});
  }
}

export async function runSelfTests(db, options = {}) {
  const results = [];
  for (const result of [
    await runControlPlaneHttpTest(db, options),
    runTelegramTransportTest(db, options),
    runDbIntegrityTest(db, options),
    runSessionCanaryReadOnlyTest(db, options),
    await runInstagramPageShapeProbe(db, options)
  ]) {
    results.push(writeResult(db, result));
  }

  const synthetic = runSyntheticChecks(db, options);
  for (const result of synthetic.results) results.push(result);

  const summary = summarizeSelfTests(readSelfTestResults(db));
  db.prepare(`
    INSERT INTO system_flags(key, value, updated_at)
    VALUES ('SELF_TEST_SUMMARY', ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')
  `).run(JSON.stringify(summary));

  return { results, summary };
}

export async function runSelfTestsForDefaultDb(options = {}) {
  const dbPath = path.resolve(options.dbPath || process.env.IG_AUTOMATION_DB_PATH || 'data/ig_automation.db');
  const db = new Database(dbPath);
  try {
    return await runSelfTests(db, options);
  } finally {
    db.close();
  }
}
