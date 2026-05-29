import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { normalizeInstagramPostUrl } from '../core/telegram-intake.js';

export function ingestManualCandidateUrl(db, rawUrl) {
  const canonicalUrl = normalizeInstagramPostUrl(String(rawUrl || '').replace(/[),.!?]+$/g, '').trim());
  if (!canonicalUrl) {
    throw new Error('Invalid Instagram post URL. Expected a post/reel/tv link.');
  }

  const info = db.prepare(`INSERT OR IGNORE INTO candidates(post_url, source) VALUES(?, 'manual')`).run(canonicalUrl);
  const row = db.prepare(`SELECT id FROM candidates WHERE post_url=?`).get(canonicalUrl);
  return {
    status: 'ok',
    candidateId: row.id,
    postUrl: canonicalUrl,
    created: info.changes > 0
  };
}

function main() {
  const url = process.argv[2];
  if (!url) {
    console.error('Usage: npm run enqueue -- <instagram_post_url>');
    process.exit(1);
  }

  const db = new Database(path.resolve('data/ig_automation.db'));
  const result = ingestManualCandidateUrl(db, url);
  console.log(`Candidate id=${result.candidateId} ${result.created ? 'created' : 'exists'} ${result.postUrl}`);
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  try {
    main();
  } catch (error) {
    console.error(error?.message || String(error));
    process.exit(1);
  }
}
