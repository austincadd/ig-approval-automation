import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { registerTelegramMessageIntake } from '../bot/telegram-message-intake.js';

const handlers = [];
const sentMessages = [];
const sentCards = [];
const bot = {
  on(event, handler) {
    handlers.push({ event, handler });
  },
  async sendMessage(chatId, text) {
    sentMessages.push({ chatId, text });
  }
};

const db = new Database(':memory:');
const candidates = new Map([
  [1, { id: 1, postUrl: 'https://www.instagram.com/p/one/' }],
  [2, { id: 2, postUrl: 'https://www.instagram.com/p/two/' }],
  [3, { id: 3, postUrl: 'https://www.instagram.com/p/three/' }]
]);

const intakeQueue = [];
registerTelegramMessageIntake({
  bot,
  db,
  chatId: 'test-chat',
  isAuthorizedActor: ({ chatIdValue, userIdValue }) => String(chatIdValue) === '123' && String(userIdValue) === '123',
  getCandidateForReview: (candidateId) => candidates.get(candidateId) || null,
  sendReviewCard: async (candidate, targetChatId) => {
    sentCards.push({ candidateId: candidate.id, targetChatId });
    if (candidate.id === 3) throw new Error('simulated send failure');
  },
  ingestPostLinks: () => {
    assert.ok(intakeQueue.length > 0, 'expected queued intake result');
    return intakeQueue.shift();
  }
});

assert.equal(handlers.length, 1, 'expected a single Telegram message registration');
assert.equal(handlers[0].event, 'message', 'expected raw message registration');
const handleMessage = handlers[0].handler;

await handleMessage({ chat: { id: 999 }, from: { id: 999 }, text: 'https://www.instagram.com/p/one/' });
assert.equal(sentMessages.length, 0, 'unauthorized messages should be ignored');

await handleMessage({ chat: { id: 123 }, from: { id: 123 }, text: '/stories_help' });
assert.equal(sentMessages.length, 0, 'slash commands should be ignored by raw intake');

intakeQueue.push({ status: 'ignored', reason: 'NO_INSTAGRAM_POST_URLS', items: [] });
await handleMessage({ chat: { id: 123 }, from: { id: 123 }, text: 'hello there' });
assert.equal(sentMessages.length, 0, 'messages without intake items should not emit summaries');

intakeQueue.push({
  status: 'ok',
  items: [
    { candidateId: 1, postUrl: candidates.get(1).postUrl, created: true, decision: null, hasOpenReviewCard: false }
  ]
});
await handleMessage({ chat: { id: 123 }, from: { id: 123, username: 'austin' }, text: 'single link' });
assert.deepEqual(sentCards, [{ candidateId: 1, targetChatId: 123 }], 'single fresh item should send one review card');
assert.equal(sentMessages.length, 0, 'single successful review-card send should suppress summary message');

intakeQueue.push({
  status: 'ok',
  items: [
    { candidateId: 1, postUrl: candidates.get(1).postUrl, created: false, decision: 'approved', hasOpenReviewCard: false },
    { candidateId: 2, postUrl: candidates.get(2).postUrl, created: true, decision: null, hasOpenReviewCard: false }
  ]
});
await handleMessage({ chat: { id: 123 }, from: { id: 123, username: 'austin' }, text: 'multi link' });
assert.deepEqual(sentCards.slice(1), [{ candidateId: 2, targetChatId: 123 }], 'multi-item intake should still send eligible review cards');
assert.equal(sentMessages.length, 1, 'multi-item intake should emit a summary');
assert.equal(
  sentMessages[0].text,
  'Known candidate 1: already approved.\nCaptured candidate 2: review card sent.',
  'summary should describe mixed known and newly sent intake items'
);

sentMessages.length = 0;
intakeQueue.push({
  status: 'ok',
  items: [
    { candidateId: 404, postUrl: 'https://www.instagram.com/p/missing/', created: true, decision: null, hasOpenReviewCard: false }
  ]
});
await handleMessage({ chat: { id: 123 }, from: { id: 123, username: 'austin' }, text: 'missing candidate' });
assert.deepEqual(sentMessages, [{ chatId: 'test-chat', text: 'Captured https://www.instagram.com/p/missing/, but candidate lookup failed.' }], 'missing candidate should emit lookup-failed summary');

sentMessages.length = 0;
intakeQueue.push({
  status: 'ok',
  items: [
    { candidateId: 3, postUrl: candidates.get(3).postUrl, created: true, decision: null, hasOpenReviewCard: false }
  ]
});
await handleMessage({ chat: { id: 123 }, from: { id: 123, username: 'austin' }, text: 'failing card send' });
assert.deepEqual(sentMessages, [{ chatId: 'test-chat', text: 'Raw-link intake failed: simulated send failure' }], 'send failures should surface a raw-link failure message');

console.log('Telegram message intake validation passed');
