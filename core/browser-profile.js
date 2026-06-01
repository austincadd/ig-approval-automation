import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { CHALLENGE_SELECTORS, detectChallengeFromSignals } from '../worker/safety.js';
import { acquireExecutorOwner, heartbeatExecutorOwner, releaseExecutorOwner } from './executor-ownership.js';

const SINGLETON_FILES = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
const OPENCLAW_LOCK_FILE = '.openclaw-profile.lock.json';

function singletonPath(profileDir, name) {
  return path.resolve(profileDir, name);
}

function openclawLockPath(profileDir) {
  return path.resolve(profileDir, OPENCLAW_LOCK_FILE);
}

function lockFileExists(profileDir) {
  return SINGLETON_FILES.some((name) => fs.existsSync(singletonPath(profileDir, name)));
}

function readOpenclawLock(profileDir) {
  try {
    const raw = fs.readFileSync(openclawLockPath(profileDir), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function acquireBrowserProfileLock({
  profileDir,
  owner,
  timeoutMs = 0,
  pollMs = 250
} = {}) {
  const startedAt = Date.now();
  const profilePath = path.resolve(profileDir || '.browser-profile');
  fs.mkdirSync(profilePath, { recursive: true });
  const normalizedOwner = owner || `pid:${process.pid}`;

  while (true) {
    const existingOpenclawLock = readOpenclawLock(profilePath);
    if (existingOpenclawLock && existingOpenclawLock.owner !== normalizedOwner) {
      if ((Date.now() - startedAt) > timeoutMs) {
        const err = new Error('Browser profile already locked by another OpenClaw owner');
        err.code = 'BROWSER_PROFILE_LOCKED';
        err.profileDir = profilePath;
        err.lockOwner = existingOpenclawLock.owner;
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      continue;
    }

    if (lockFileExists(profilePath)) {
      if ((Date.now() - startedAt) > timeoutMs) {
        const err = new Error('Browser profile busy');
        err.code = 'BROWSER_PROFILE_BUSY';
        err.profileDir = profilePath;
        err.owner = normalizedOwner;
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      continue;
    }

    fs.writeFileSync(openclawLockPath(profilePath), JSON.stringify({ owner: normalizedOwner, pid: process.pid, createdAt: new Date().toISOString() }));
    break;
  }

  return {
    profileDir: profilePath,
    owner: normalizedOwner,
    release() {
      try {
        const current = readOpenclawLock(profilePath);
        if (!current || current.owner === normalizedOwner) fs.rmSync(openclawLockPath(profilePath), { force: true });
      } catch {}
      return true;
    }
  };
}

export async function detectSessionChallenge(page) {
  try {
    const loginFormCount = await page.locator('form[action*="/accounts/login"]').count();
    if (loginFormCount > 0) {
      return {
        blocked: true,
        reason: 'CHALLENGE_SELECTOR',
        detail: 'login_form_present'
      };
    }
  } catch {}

  const signals = await detectChallengeFromSignals(page, CHALLENGE_SELECTORS);
  if (signals.challenge) {
    return {
      blocked: true,
      reason: signals.reason || 'challenge_detected',
      detail: signals.detail || null
    };
  }
  return { blocked: false };
}

export async function launchBrowserSessionWithPreflight({
  chromium,
  profileDir,
  owner,
  db = null,
  lockTimeoutMs = 0,
  lockPollMs = 250,
  headless = false,
  homeUrl = 'https://www.instagram.com/',
  navigationTimeoutMs = 30000
} = {}) {
  const lock = await acquireBrowserProfileLock({
    profileDir,
    owner,
    timeoutMs: lockTimeoutMs,
    pollMs: lockPollMs
  });

  if (db) {
    acquireExecutorOwner(db, {
      ownerKey: 'browser-profile',
      mode: owner || 'unknown',
      pid: process.pid,
      profileDir: lock.profileDir,
      details: { lockOwner: owner || 'unknown' }
    });
  }

  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(lock.profileDir, { headless });
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto(homeUrl, { waitUntil: 'domcontentloaded', timeout: navigationTimeoutMs });
    const challenge = await detectSessionChallenge(page);

    if (challenge.blocked) {
      const err = new Error(`Browser session preflight blocked: ${challenge.reason}${challenge.detail ? ` (${challenge.detail})` : ''}`);
      err.code = 'BROWSER_SESSION_NOT_READY';
      err.reason = challenge.reason;
      err.detail = challenge.detail;
      err.preflightUrl = page.url();
      throw err;
    }

    if (db) heartbeatExecutorOwner(db, { ownerKey: 'browser-profile', details: { preflightUrl: page.url() } });

    return {
      ctx,
      page,
      lock,
      preflightUrl: page.url(),
      heartbeat(details = {}) {
        if (db) heartbeatExecutorOwner(db, { ownerKey: 'browser-profile', details });
      },
      releaseOwnership() {
        if (db) releaseExecutorOwner(db, { ownerKey: 'browser-profile' });
      }
    };
  } catch (err) {
    try { await ctx?.close(); } catch {}
    try { if (db) releaseExecutorOwner(db, { ownerKey: 'browser-profile' }); } catch {}
    try { lock.release(); } catch {}
    throw err;
  }
}
