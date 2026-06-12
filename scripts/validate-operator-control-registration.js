import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { registerOperatorTelegramCommands, OPERATOR_TELEGRAM_COMMAND_PATTERNS } from '../bot/operator-telegram-commands.js';
import { registerOperatorHttpRoutes } from '../bot/operator-http-routes.js';

const telegramRegistrations = [];
const bot = {
  onText(pattern, handler) {
    telegramRegistrations.push({ pattern, handler });
  }
};

const httpRegistrations = [];
const app = {
  post(path, handler) {
    httpRegistrations.push({ method: 'POST', path, handler });
  },
  get(path, handler) {
    httpRegistrations.push({ method: 'GET', path, handler });
  }
};

const db = new Database(':memory:');
registerOperatorTelegramCommands({
  bot,
  db,
  chatId: 'test-chat',
  requireAuthorizedChat: () => true
});
registerOperatorHttpRoutes({
  app,
  db,
  isAuthorizedControlRequest: () => true,
  rejectUnauthorizedControlRequest: () => undefined,
  sendReviewBatch: async () => ({ sent: 0 })
});

const expectedTelegramPatterns = Object.values(OPERATOR_TELEGRAM_COMMAND_PATTERNS).map((pattern) => pattern.source);
assert.equal(telegramRegistrations.length, expectedTelegramPatterns.length, 'expected one registration per operator Telegram command');
for (const source of expectedTelegramPatterns) {
  assert.ok(
    telegramRegistrations.some(({ pattern }) => pattern instanceof RegExp && pattern.source === source),
    `expected Telegram command registration for ${source}`
  );
}
for (const { handler } of telegramRegistrations) {
  assert.equal(typeof handler, 'function', 'Telegram registrations should provide handler functions');
}

assert.deepEqual(
  httpRegistrations.map(({ method, path }) => ({ method, path })),
  [
    { method: 'POST', path: '/review/push' },
    { method: 'GET', path: '/automation/status' },
    { method: 'GET', path: '/automation/readiness' },
    { method: 'GET', path: '/automation/executor' },
    { method: 'GET', path: '/automation/soak' },
    { method: 'GET', path: '/automation/incidents' },
    { method: 'GET', path: '/automation/dashboard' },
    { method: 'POST', path: '/automation/action' },
    { method: 'GET', path: '/automation/self-tests' },
    { method: 'POST', path: '/automation/self-tests/run' },
    { method: 'POST', path: '/automation/remediation/run' },
    { method: 'POST', path: '/automation/incidents/:incidentKey/suppress' },
    { method: 'POST', path: '/automation/incidents/:incidentKey/resolve' },
    { method: 'GET', path: '/automation/metrics' },
    { method: 'GET', path: '/debug/queue' }
  ],
  'expected operator HTTP routes to register in stable order'
);
for (const { handler } of httpRegistrations) {
  assert.equal(typeof handler, 'function', 'HTTP route registrations should provide handler functions');
}

console.log('Operator control registration validation passed');
