import path from 'node:path';
import Database from 'better-sqlite3';
import { getSoakReport } from '../core/soak-report.js';
import { evaluateSlo } from '../core/slo-policy.js';
import { getOperatorAutomationStatus } from '../core/automation-status.js';

const db = new Database(path.resolve(process.env.IG_AUTOMATION_DB_PATH || 'data/ig_automation.db'));
const days = Math.max(1, Math.trunc(Number(process.argv[2]) || 7));
const status = getOperatorAutomationStatus(db, { soakWindowDays: days });
const soak = getSoakReport(db, { days });
const slo = evaluateSlo(status, soak);
console.log(JSON.stringify({ soak, slo }, null, 2));
db.close();
