import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  extractInstagramPostUrlsFromMessage,
  ingestTelegramPostLinks,
  normalizeInstagramPostUrl
} from '../core/telegram-intake.js';

const schema = fs.readFileSync(path.resolve('db/schema.sql'), 'utf8');
const db = new Database(':memory:');
db.exec(schema);

assert.equal(
  normalizeInstagramPostUrl('https://www.instagram.com/reel/DW1l10nEYez/?igsh=abc123'),
  'https://www.instagram.com/reel/DW1l10nEYez/',
  'raw reel url should canonicalize and drop query params'
);
assert.equal(
  normalizeInstagramPostUrl('https://instagram.com/p/ABCdef12345?utm_source=share'),
  'https://www.instagram.com/p/ABCdef12345/',
  'bare instagram host post url should canonicalize'
);
assert.equal(
  normalizeInstagramPostUrl('https://m.instagram.com/tv/CODE123/?foo=bar'),
  'https://www.instagram.com/tv/CODE123/',
  'mobile host tv url should canonicalize'
);
assert.equal(
  normalizeInstagramPostUrl('https://www.instagram.com/austin/'),
  null,
  'profile urls should not be accepted as approval candidates'
);

const message = {
  chat: { id: 1872856256 },
  from: { id: 1872856256, username: 'austin' },
  message_id: 42,
  text: 'check this one https://www.instagram.com/reel/DW1l10nEYez/?igsh=abc123 and also https://www.instagram.com/p/ABCdef12345/'
};

assert.deepEqual(
  extractInstagramPostUrlsFromMessage(message),
  [
    'https://www.instagram.com/reel/DW1l10nEYez/',
    'https://www.instagram.com/p/ABCdef12345/'
  ],
  'message text should yield canonical instagram post urls'
);

const intake1 = ingestTelegramPostLinks(db, message, {
  actor: 'telegram:austin',
  source: 'telegram'
});
assert.equal(intake1.status, 'ok');
assert.equal(intake1.items.length, 2);
assert.equal(intake1.items.filter((item) => item.created).length, 2, 'first intake should create both candidates');

const candidateRows = db.prepare(`SELECT id, post_url, source FROM candidates ORDER BY id ASC`).all();
assert.deepEqual(
  candidateRows.map((row) => row.post_url),
  [
    'https://www.instagram.com/reel/DW1l10nEYez/',
    'https://www.instagram.com/p/ABCdef12345/'
  ],
  'candidates should be persisted canonically'
);
assert.ok(candidateRows.every((row) => row.source === 'telegram'), 'telegram intake should tag candidates with source=telegram');

const pendingReviewIds = db.prepare(`
  SELECT c.id
  FROM candidates c
  LEFT JOIN approvals a ON a.candidate_id = c.id
  LEFT JOIN review_card_messages r ON r.candidate_id = c.id AND r.status = 'open'
  WHERE a.id IS NULL
    AND r.id IS NULL
  ORDER BY c.id ASC
`).all().map((row) => row.id);
assert.deepEqual(
  pendingReviewIds,
  candidateRows.map((row) => row.id),
  'new telegram candidates should immediately be eligible for review-card push'
);

const intake2 = ingestTelegramPostLinks(db, {
  ...message,
  message_id: 43,
  caption: 'duplicate https://www.instagram.com/reel/DW1l10nEYez/?utm_source=share'
}, {
  actor: 'telegram:austin',
  source: 'telegram'
});
assert.equal(intake2.status, 'ok');
assert.equal(intake2.items.length, 2, 'duplicate message should still report recognized links');
assert.equal(intake2.items.filter((item) => item.created).length, 0, 'duplicate intake should not create duplicate candidates');
assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM candidates`).get().count, 2, 'candidate table should remain deduplicated');

const firstCandidateId = candidateRows[0].id;
db.prepare(`INSERT INTO review_card_messages(candidate_id, chat_id, message_id, status) VALUES (?, 'chat', 1001, 'open')`).run(firstCandidateId);
const postCardPendingIds = db.prepare(`
  SELECT c.id
  FROM candidates c
  LEFT JOIN approvals a ON a.candidate_id = c.id
  LEFT JOIN review_card_messages r ON r.candidate_id = c.id AND r.status = 'open'
  WHERE a.id IS NULL
    AND r.id IS NULL
  ORDER BY c.id ASC
`).all().map((row) => row.id);
assert.deepEqual(postCardPendingIds, [candidateRows[1].id], 'open review card should suppress duplicate review dispatch');

console.log('Telegram raw-link intake validation passed');
