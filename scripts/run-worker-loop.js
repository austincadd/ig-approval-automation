import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { randomInt } from 'node:crypto';
import 'dotenv/config';
import { installTimestampedConsole } from './lib/timestamped-console.js';
import { acquireExecutorOwner, heartbeatExecutorOwner, releaseExecutorOwner } from '../core/executor-ownership.js';
import { recoverInterruptedRunningJobs } from '../core/executor-runtime.js';

installTimestampedConsole();

const dbPath = path.resolve(process.env.IG_AUTOMATION_DB_PATH || 'data/ig_automation.db');
const db = new Database(dbPath);
const wakeFiles = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
const workerOnceScript = path.resolve(process.env.WORKER_ONCE_SCRIPT || 'worker/run-once.js');

const cooldownMinMs = clampMs(process.env.WORKER_COOLDOWN_MIN_MS, 120000);
const cooldownMaxMs = Math.max(cooldownMinMs, clampMs(process.env.WORKER_COOLDOWN_MAX_MS, 480000));
const pausedPollMs = clampMs(process.env.WORKER_PAUSED_POLL_MS, 60000);
const idlePollMs = clampMs(process.env.WORKER_IDLE_POLL_MS, 60000);
const wakePollMs = clampMs(process.env.WORKER_WAKE_POLL_MS, 1000);
const workerHeartbeatMs = clampMs(process.env.WORKER_HEARTBEAT_MS, 30000);
const disableFsWatch = ['1', 'true', 'yes'].includes(String(process.env.WORKER_DISABLE_FS_WATCH || '').toLowerCase());
const workerOwnerKey = 'worker-loop';

function clampMs(rawValue, fallback) {
  const value = Number(rawValue);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(25, Math.trunc(value));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFileWakeSnapshot() {
  return wakeFiles.map((filePath) => {
    try {
      const stat = fs.statSync(filePath);
      return {
        filePath,
        exists: true,
        size: stat.size,
        mtimeMs: stat.mtimeMs
      };
    } catch {
      return {
        filePath,
        exists: false,
        size: null,
        mtimeMs: null
      };
    }
  });
}

function getWakeSnapshot() {
  return JSON.stringify({
    dataVersion: db.pragma('data_version', { simple: true }),
    automationEnabled: isAutomationEnabled(),
    queuedCount: getQueuedJobCount(),
    files: getFileWakeSnapshot()
  });
}

function waitForDbWakeOrTimeout(timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const watchers = [];
    const initialSnapshot = getWakeSnapshot();

    const finish = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poller);
      for (const watcher of watchers) {
        try { watcher.close(); } catch {}
      }
      resolve(reason);
    };

    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    const poller = setInterval(() => {
      if (getWakeSnapshot() !== initialSnapshot) finish('db-change');
    }, Math.min(wakePollMs, timeoutMs));
    poller.unref?.();

    if (!disableFsWatch) {
      for (const wakeFile of wakeFiles) {
        if (!fs.existsSync(wakeFile)) continue;
        try {
          const watcher = fs.watch(wakeFile, () => finish('db-change'));
          watcher.on('error', () => {
            try { watcher.close(); } catch {}
          });
          watchers.push(watcher);
        } catch {}
      }
    }
  });
}

async function waitForNextLoop({ timeoutMs, wakeOnDbChange = false }) {
  if (!wakeOnDbChange) {
    await sleep(timeoutMs);
    return 'timeout';
  }
  const reason = await waitForDbWakeOrTimeout(timeoutMs);
  if (reason === 'db-change') console.log('Worker wake signal: database changed.');
  return reason;
}

function isAutomationEnabled() {
  const value = db.prepare(`SELECT value FROM system_flags WHERE key='AUTOMATION_ENABLED'`).get()?.value;
  return String(value ?? 'true').toLowerCase() === 'true';
}

function getQueuedJobCount() {
  return db.prepare(`SELECT COUNT(*) AS count FROM like_jobs WHERE status='queued'`).get().count;
}

async function runWorkerOnce() {
  await new Promise((resolve) => {
    const p = spawn('node', [workerOnceScript], { stdio: 'inherit', env: process.env });
    p.on('exit', () => resolve());
  });
}

function logStateTransition(previousState, nextState, queuedCount = 0) {
  if (previousState === nextState) return previousState;

  if (nextState === 'paused') {
    console.log('Automation paused; worker idle until resumed.');
  } else if (nextState === 'idle') {
    console.log('No queued jobs; worker idle.');
  } else if (nextState === 'active') {
    console.log(`Worker active; ${queuedCount} queued job${queuedCount === 1 ? '' : 's'} ready.`);
  }

  return nextState;
}

async function loop() {
  let workerState = 'boot';
  acquireExecutorOwner(db, {
    ownerKey: workerOwnerKey,
    mode: 'worker-loop',
    pid: process.pid,
    profileDir: '.browser-profile',
    details: { script: 'run-worker-loop' }
  });

  const heartbeatTimer = setInterval(() => {
    try { heartbeatExecutorOwner(db, { ownerKey: workerOwnerKey, details: { state: workerState } }); } catch {}
  }, workerHeartbeatMs);
  heartbeatTimer.unref?.();

  const interrupted = recoverInterruptedRunningJobs(db, { actor: 'worker-loop', reason: 'loop_start_recovery' });
  if (interrupted.recovered > 0) {
    console.log(`Recovered ${interrupted.recovered} interrupted running job${interrupted.recovered === 1 ? '' : 's'}.`);
  }

  try {
    while (true) {
      if (!isAutomationEnabled()) {
        workerState = logStateTransition(workerState, 'paused');
        await waitForNextLoop({ timeoutMs: pausedPollMs, wakeOnDbChange: true });
        continue;
      }

      const queuedCount = getQueuedJobCount();
      if (queuedCount < 1) {
        workerState = logStateTransition(workerState, 'idle');
        await waitForNextLoop({ timeoutMs: idlePollMs, wakeOnDbChange: true });
        continue;
      }

      workerState = logStateTransition(workerState, 'active', queuedCount);
      heartbeatExecutorOwner(db, { ownerKey: workerOwnerKey, details: { state: workerState, queuedCount } });
      await runWorkerOnce();
      await waitForNextLoop({ timeoutMs: randomInt(cooldownMinMs, cooldownMaxMs + 1), wakeOnDbChange: true });
    }
  } finally {
    clearInterval(heartbeatTimer);
    releaseExecutorOwner(db, { ownerKey: workerOwnerKey });
  }
}

loop();
