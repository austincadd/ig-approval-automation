import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { registerOperatorTelegramCommands } from '../bot/operator-telegram-commands.js';
import { registerOperatorHttpRoutes } from '../bot/operator-http-routes.js';

const schema = fs.readFileSync(path.resolve('db/schema.sql'), 'utf8');
const db = new Database(':memory:');
db.exec(schema);

const insertCandidate = db.prepare(`INSERT INTO candidates(post_url, source) VALUES (?, 'test')`);
const insertApproval = db.prepare(`INSERT INTO approvals(candidate_id, decision, decided_by) VALUES (?, ?, 'test')`);
const insertJob = db.prepare(`
  INSERT INTO like_jobs(candidate_id, status, started_at, finished_at, error_code, error_message, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
`);

insertCandidate.run('https://instagram.com/p/queued');
insertCandidate.run('https://instagram.com/p/approved');
insertApproval.run(1, 'approved');
insertApproval.run(2, 'approved');
insertJob.run(1, 'queued', null, null, null, null);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-operator-control-'));
const lockPath = path.join(tempDir, 'telegram-bot.lock');
const outLog = path.join(tempDir, 'worker.out.log');
const errLog = path.join(tempDir, 'worker.err.log');
fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: '2026-05-27T14:00:00.000Z', label: 'telegram bot/callback server' }));
fs.writeFileSync(outLog, '[2026-05-27T14:03:00.000Z] Worker active\n');
fs.writeFileSync(errLog, '[2026-05-27T14:02:00.000Z] Worker idle\n');

process.env.TELEGRAM_BOT_LOCK_PATH = lockPath;
process.env.WORKER_STDOUT_LOG_PATH = outLog;
process.env.WORKER_STDERR_LOG_PATH = errLog;
process.env.WORKER_LAUNCHD_LABEL = 'com.example.missing-worker';

const sentMessages = [];
const telegramHandlers = [];
const bot = {
  onText(pattern, handler) {
    telegramHandlers.push({ pattern, handler });
  },
  async sendMessage(chatId, text) {
    sentMessages.push({ chatId, text });
  }
};

registerOperatorTelegramCommands({
  bot,
  db,
  chatId: 'test-chat',
  requireAuthorizedChat: (id) => id === 123
});

function getTelegramHandler(command) {
  const literal = command.replace('/', '\\/');
  const entry = telegramHandlers.find(({ pattern }) => pattern.source.startsWith(literal));
  assert.ok(entry, `expected Telegram handler for ${command}`);
  return entry.handler;
}

await getTelegramHandler('/automation_status')({ chat: { id: 123 } });
assert.equal(sentMessages.length, 1, 'automation_status should send one message');
assert.equal(sentMessages[0].chatId, 'test-chat');
assert.match(sentMessages[0].text, /Automation:/);
assert.match(sentMessages[0].text, /Queue: queued=1/);

sentMessages.length = 0;
await getTelegramHandler('/pause_automation')({ chat: { id: 999 } }, ['/pause_automation']);
assert.equal(sentMessages.length, 0, 'unauthorized Telegram command should be ignored');

await getTelegramHandler('/pause_automation')(
  { chat: { id: 123 }, from: { username: 'alice' } },
  ['/pause_automation urgent maintenance', 'urgent maintenance']
);
assert.equal(sentMessages.length, 1, 'pause_automation should acknowledge authorized requests');
assert.match(sentMessages[0].text, /Automation paused\./);
assert.match(sentMessages[0].text, /Reason: urgent maintenance/);

sentMessages.length = 0;
await getTelegramHandler('/resume_automation')(
  { chat: { id: 123 }, from: { username: 'alice' } },
  ['/resume_automation', undefined]
);
assert.equal(sentMessages.length, 1, 'resume_automation should use default reason when omitted');
assert.match(sentMessages[0].text, /Automation resumed\.|Automation was already running\./);
assert.match(sentMessages[0].text, /Reason: telegram_resume/);

const routes = [];
const app = {
  post(routePath, handler) {
    routes.push({ method: 'POST', path: routePath, handler });
  },
  get(routePath, handler) {
    routes.push({ method: 'GET', path: routePath, handler });
  }
};

let reviewBatchCalls = 0;
let rejectCalls = 0;
registerOperatorHttpRoutes({
  app,
  db,
  isAuthorizedControlRequest: (req) => req.authorized === true,
  rejectUnauthorizedControlRequest: (_req, res) => {
    rejectCalls += 1;
    return res.status(403).json({ ok: false, error: 'forbidden' });
  },
  sendReviewBatch: async () => {
    reviewBatchCalls += 1;
    return { sent: 2, skipped: 1 };
  }
});

function getRoute(method, routePath) {
  const entry = routes.find((route) => route.method === method && route.path === routePath);
  assert.ok(entry, `expected ${method} ${routePath} route`);
  return entry.handler;
}

function createRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
}

let res = createRes();
await getRoute('POST', '/review/push')({ authorized: false }, res);
assert.equal(rejectCalls, 1, 'unauthorized review push should delegate rejection');
assert.equal(reviewBatchCalls, 0, 'unauthorized review push should not send a review batch');
assert.equal(res.statusCode, 403);
assert.deepEqual(res.body, { ok: false, error: 'forbidden' });

res = createRes();
await getRoute('POST', '/review/push')({ authorized: true }, res);
assert.equal(reviewBatchCalls, 1, 'authorized review push should run sendReviewBatch');
assert.equal(res.statusCode, 200);
assert.deepEqual(res.body, { ok: true, sent: 2, skipped: 1 });

res = createRes();
getRoute('GET', '/automation/status')({}, res);
assert.equal(res.statusCode, 200);
assert.equal(res.body.ok, true);
assert.equal(res.body.status.counts.queued, 1);

res = createRes();
getRoute('GET', '/automation/metrics')({ query: { days: '30' } }, res);
assert.equal(res.statusCode, 200);
assert.equal(res.body.ok, true);
assert.ok(res.body.metrics.summary);

res = createRes();
getRoute('GET', '/debug/queue')({}, res);
assert.equal(res.statusCode, 200);
assert.equal(res.body.ok, true);
assert.equal(res.body.queued.length, 1, 'debug queue should include queued jobs');
assert.equal(res.body.queued[0].candidate_id, 1);
assert.equal(res.body.recentApprovals.length, 2, 'debug queue should include recent approvals');

console.log('Operator control behavior validation passed');
