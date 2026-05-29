import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { runSelfTests, readSelfTestResults } from '../core/self-tests.js';
import { getOperatorAutomationStatus } from '../core/automation-status.js';

const schema = fs.readFileSync(path.resolve('db/schema.sql'), 'utf8');
const db = new Database(':memory:');
db.exec(schema);

db.prepare(`INSERT INTO system_flags(key, value, updated_at) VALUES ('TELEGRAM_TRANSPORT_HEALTH', ?, datetime('now'))`).run(JSON.stringify({ status: 'ok', duplicatePollerDetected: false, sendFailures: 0, lastError: null }));
db.prepare(`INSERT INTO system_flags(key, value, updated_at) VALUES ('EXECUTOR_CANARY_RESULT', ?, datetime('now'))`).run(JSON.stringify({ ok: true, state: 'healthy', code: null }));

const result = await runSelfTests(db, {
  controlPlaneStatusUrl: 'http://127.0.0.1:1/automation/status',
  enableBrowserProbe: false,
  pageShapeProbeUrl: 'https://www.instagram.com/'
});

assert.equal(result.results.length, 5);
const stored = readSelfTestResults(db);
assert.equal(stored.length, 5);
assert.ok(stored.some((row) => row.testKey === 'instagram_page_shape_probe' && row.status === 'skipped'));
assert.ok(stored.some((row) => row.testKey === 'control_plane_http'));

const status = getOperatorAutomationStatus(db);
assert.equal(status.selfTests.results.length, 5);
assert.equal(status.policyVersions.schemaVersion, '2026-05-29.phase5');
assert.match(JSON.stringify(status.selfTests.summary), /overall/);

console.log('Self-tests validation passed');
