import path from 'node:path';
import Database from 'better-sqlite3';
import { suppressRecoveryCandidate } from '../core/recovery.js';

const candidateIdArg = process.argv[2];
const candidateId = Number(candidateIdArg);
if (!Number.isSafeInteger(candidateId) || candidateId <= 0) {
  console.error('Usage: node scripts/suppress-recovery-candidate.js <candidateId> [reason]');
  process.exit(1);
}

const reason = process.argv.slice(3).join(' ').trim() || null;
const db = new Database(path.resolve('data/ig_automation.db'));
const result = suppressRecoveryCandidate(db, {
  actor: 'cli:suppress-recovery-candidate',
  candidateId,
  reason
});
console.log(JSON.stringify(result, null, 2));
