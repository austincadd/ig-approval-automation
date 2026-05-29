import path from 'node:path';
import Database from 'better-sqlite3';

const db = new Database(path.resolve('data/ig_automation.db'));
const stats = db.prepare(`
SELECT
  SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) success,
  SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed,
  SUM(CASE WHEN status='blocked' THEN 1 ELSE 0 END) blocked,
  SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END) queued
FROM like_jobs
WHERE datetime(created_at) > datetime('now','-1 day')
`).get();
console.log('Daily stats (24h):', stats);
