import path from 'node:path';
import Database from 'better-sqlite3';
import { pauseAutomation } from '../core/recovery.js';

const db = new Database(path.resolve('data/ig_automation.db'));
const reason = process.argv.slice(2).join(' ').trim() || null;
const result = pauseAutomation(db, { actor: 'cli:pause', reason });
console.log(JSON.stringify(result, null, 2));
