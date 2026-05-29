import path from 'node:path';
import Database from 'better-sqlite3';
import { reconcileApprovedQueue } from '../core/recovery.js';

const db = new Database(path.resolve('data/ig_automation.db'));
const reason = process.argv.slice(2).join(' ').trim() || null;
const result = reconcileApprovedQueue(db, { actor: 'cli:reconcile-approved', reason });
console.log(JSON.stringify(result, null, 2));
