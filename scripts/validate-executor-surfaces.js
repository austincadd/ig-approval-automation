import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { acquireExecutorOwner } from '../core/executor-ownership.js';
import { getOperatorAutomationStatus, formatOperatorAutomationStatus } from '../core/automation-status.js';
import { renderOperatorDashboard } from '../core/operator-dashboard.js';

const schema = fs.readFileSync(path.resolve('db/schema.sql'), 'utf8');
const db = new Database(':memory:');
db.exec(schema);
acquireExecutorOwner(db, { ownerKey: 'browser-profile', mode: 'worker-loop', pid: process.pid, profileDir: '.browser-profile' });

const status = getOperatorAutomationStatus(db);
assert.ok(status.executorOwner);
assert.equal(status.executorOwner.owner.mode, 'worker-loop');
const text = formatOperatorAutomationStatus(status);
assert.match(text, /Executor owner:/);
const html = renderOperatorDashboard(status);
assert.match(html, /Executor owner/);
assert.match(html, /Reclaim stale executor owner/);

console.log('Executor surfaces validation passed');
