import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ingestManualCandidateUrl } from '../scripts/enqueue-candidate.js';
import { normalizeInstagramPostUrl } from '../core/telegram-intake.js';

const schema = fs.readFileSync(path.resolve('db/schema.sql'), 'utf8');
const db = new Database(':memory:');
db.exec(schema);

const variants = [
  ['https://instagram.com/p/ABCdef12345?igsh=abc', 'https://www.instagram.com/p/ABCdef12345/'],
  ['https://m.instagram.com/reel/DW1l10nEYez/?utm_source=share', 'https://www.instagram.com/reel/DW1l10nEYez/'],
  ['https://www.instagram.com/tv/CODE123/?foo=bar', 'https://www.instagram.com/tv/CODE123/'],
  ['https://www.instagram.com/p/ABCdef12345),', 'https://www.instagram.com/p/ABCdef12345/']
];

for (const [raw, expected] of variants) {
  const cleaned = raw.replace(/[),.!?]+$/g, '');
  assert.equal(normalizeInstagramPostUrl(cleaned), expected, `expected canonical normalization for ${raw}`);
}

assert.equal(normalizeInstagramPostUrl('https://www.instagram.com/austin/'), null);
assert.equal(normalizeInstagramPostUrl('not-a-url'), null);

const first = ingestManualCandidateUrl(db, 'https://m.instagram.com/reel/DW1l10nEYez/?utm_source=share');
assert.equal(first.status, 'ok');
assert.equal(first.created, true);
assert.equal(first.postUrl, 'https://www.instagram.com/reel/DW1l10nEYez/');

const second = ingestManualCandidateUrl(db, 'https://www.instagram.com/reel/DW1l10nEYez/?igsh=other');
assert.equal(second.status, 'ok');
assert.equal(second.created, false, 'canonical duplicate should not create a second candidate');
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM candidates').get().count, 1);

const row = db.prepare('SELECT post_url, source FROM candidates LIMIT 1').get();
assert.deepEqual(row, {
  post_url: 'https://www.instagram.com/reel/DW1l10nEYez/',
  source: 'manual'
});

assert.throws(
  () => ingestManualCandidateUrl(db, 'https://www.instagram.com/austin/'),
  /Invalid Instagram post URL/,
  'manual intake should reject non-post/profile URLs'
);

console.log('Manual candidate intake validation passed');
