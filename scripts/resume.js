import path from 'node:path';
import Database from 'better-sqlite3';
import { resumeAutomation } from '../core/recovery.js';

const db = new Database(path.resolve('data/ig_automation.db'));
const reason = process.argv.slice(2).join(' ').trim() || null;
const result = resumeAutomation(db, { actor: 'cli:resume', reason });
console.log(JSON.stringify(result, null, 2));
