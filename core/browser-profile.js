import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { CHALLENGE_SELECTORS, detectChallengeFromSignals } from '../worker/safety.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readVisiblePageText(page) {
  return page.evaluate(() => document.body?.innerText || '').catch(() => '');
}

async function getChallengeSelectorHits(page) {
  const hits = [];
  for (const selector of CHALLENGE_SELECTORS) {
    const count = await page.locator(selector).count().catch(() => 0);
    if (count > 0) hits.push(selector);
  }
  return hits;
}

async function detectSessionChallenge(page) {
  const url = page.url();
  const [visibleText, selectorHits] = await Promise.all([
    readVisiblePageText(page),
    getChallengeSelectorHits(page)
  ]);

  return detectChallengeFromSignals({ url, visibleText, selectorHits });
}

function readLockMetadata(lockFile) {
  try {
    return JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  } catch {
    return null;
  }
}

function pidLooksAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function clearStaleLock(lockDir, metadata) {
  const pidAlive = pidLooksAlive(Number(metadata?.pid));
  if (pidAlive) return false;
  fs.rmSync(lockDir, { recursive: true, force: true });
  return true;
}

export async function acquireBrowserProfileLock({
  profileDir,
  owner,
  timeoutMs = 0,
  pollMs = 250
} = {}) {
  const resolvedProfileDir = path.resolve(profileDir || '.browser-profile');
  const lockDir = `${resolvedProfileDir}.lock`;
  const lockFile = path.join(lockDir, 'owner.json');
  const startedAt = Date.now();

  while (true) {
    try {
      fs.mkdirSync(lockDir, { recursive: false });
      const metadata = {
        owner: owner || 'unknown',
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
        profileDir: resolvedProfileDir
      };
      fs.writeFileSync(lockFile, JSON.stringify(metadata, null, 2));
      return {
        profileDir: resolvedProfileDir,
        lockDir,
        lockFile,
        metadata,
        release() {
          fs.rmSync(lockDir, { recursive: true, force: true });
        }
      };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      const metadata = readLockMetadata(lockFile);
      const cleared = clearStaleLock(lockDir, metadata);
      if (cleared) continue;

      if (Date.now() - startedAt >= timeoutMs) {
        const lockError = new Error(`Browser profile is busy (${metadata?.owner || 'unknown owner'}).`);
        lockError.code = 'BROWSER_PROFILE_LOCKED';
        lockError.lockOwner = metadata?.owner || null;
        lockError.lockPid = metadata?.pid || null;
        lockError.lockAcquiredAt = metadata?.acquiredAt || null;
        throw lockError;
      }

      await sleep(pollMs);
    }
  }
}

export async function launchBrowserSessionWithPreflight({
  chromium,
  profileDir,
  owner,
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

    return { ctx, page, lock, preflightUrl: page.url() };
  } catch (err) {
    try { await ctx?.close(); } catch {}
    try { lock.release(); } catch {}
    throw err;
  }
}
