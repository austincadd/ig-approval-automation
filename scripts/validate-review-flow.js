import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const schema = fs.readFileSync(path.resolve('db/schema.sql'), 'utf8');
const db = new Database(':memory:');
db.exec(schema);

const insertCandidate = db.prepare(`INSERT INTO candidates(post_url, source) VALUES (?, 'test')`);
const insertApproval = db.prepare(`INSERT INTO approvals(candidate_id, decision, decided_by) VALUES (?, ?, 'test')`);
const insertReviewCard = db.prepare(`INSERT INTO review_card_messages(candidate_id, chat_id, message_id, status) VALUES (?, 'chat', ?, 'open')`);
const closeCards = db.prepare(`UPDATE review_card_messages SET status='resolved', resolved_at=datetime('now') WHERE candidate_id = ? AND status = 'open'`);
const pendingForPush = db.prepare(`
  SELECT c.id
  FROM candidates c
  LEFT JOIN approvals a ON a.candidate_id = c.id
  LEFT JOIN review_card_messages r ON r.candidate_id = c.id AND r.status = 'open'
  WHERE a.id IS NULL
    AND r.id IS NULL
  ORDER BY c.id ASC
`);

insertCandidate.run('https://instagram.com/p/a');
insertCandidate.run('https://instagram.com/p/b');

assert.deepEqual(pendingForPush.all().map((row) => row.id), [1, 2], 'fresh candidates should be pushable');
insertReviewCard.run(1, 1001);
assert.deepEqual(pendingForPush.all().map((row) => row.id), [2], 'open review card should suppress duplicate push for same candidate');
assert.throws(() => insertReviewCard.run(1, 1002), /UNIQUE|unique/i, 'only one open review card per candidate should be allowed');

insertApproval.run(1, 'approved');
closeCards.run(1);
assert.deepEqual(pendingForPush.all().map((row) => row.id), [2], 'decided candidate should stay out of pending push set');
assert.equal(db.prepare(`SELECT status FROM review_card_messages WHERE candidate_id = 1`).get().status, 'resolved', 'decision should resolve open review cards');

console.log('Review flow validation passed');
