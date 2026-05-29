import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireBrowserProfileLock, launchBrowserSessionWithPreflight } from '../core/browser-profile.js';

function createMockPage({ url = 'https://www.instagram.com/', text = 'Instagram home', selectorCounts = {} } = {}) {
  return {
    async goto(nextUrl) {
      url = nextUrl;
    },
    url() {
      return url;
    },
    locator(selector) {
      return {
        async count() {
          return selectorCounts[selector] || 0;
        }
      };
    },
    async evaluate() {
      return text;
    }
  };
}

function createMockChromium(page) {
  return {
    async launchPersistentContext(profileDir) {
      return {
        profileDir,
        pages() {
          return [page];
        },
        async newPage() {
          return page;
        },
        async close() {}
      };
    }
  };
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-browser-profile-lock-'));
const profileDir = path.join(tempDir, '.browser-profile');
fs.mkdirSync(profileDir, { recursive: true });

const firstLock = await acquireBrowserProfileLock({
  profileDir,
  owner: 'validate-first-lock',
  timeoutMs: 0
});

let lockedError = null;
try {
  await acquireBrowserProfileLock({ profileDir, owner: 'validate-second-lock', timeoutMs: 0 });
} catch (err) {
  lockedError = err;
}
assert.equal(lockedError?.code, 'BROWSER_PROFILE_LOCKED', 'second profile owner should be rejected while lock is held');
assert.equal(lockedError?.lockOwner, 'validate-first-lock');
firstLock.release();

const readyPage = createMockPage();
const readySession = await launchBrowserSessionWithPreflight({
  chromium: createMockChromium(readyPage),
  profileDir,
  owner: 'validate-preflight-ready',
  lockTimeoutMs: 0,
  navigationTimeoutMs: 100
});
assert.ok(readySession.ctx, 'ready preflight should return a browser context');
assert.equal(readySession.preflightUrl, 'https://www.instagram.com/', 'ready preflight should reach the instagram home url');
await readySession.ctx.close();
readySession.lock.release();

const blockedPage = createMockPage({
  url: 'https://www.instagram.com/accounts/login/',
  text: 'Log in to Instagram',
  selectorCounts: {
    'form[action*="/accounts/login"]': 1
  }
});
let preflightError = null;
try {
  await launchBrowserSessionWithPreflight({
    chromium: createMockChromium(blockedPage),
    profileDir,
    owner: 'validate-preflight-blocked',
    lockTimeoutMs: 0,
    navigationTimeoutMs: 100
  });
} catch (err) {
  preflightError = err;
}
assert.equal(preflightError?.code, 'BROWSER_SESSION_NOT_READY', 'login/challenge state should fail preflight');
assert.equal(preflightError?.reason, 'CHALLENGE_SELECTOR');

const postErrorLock = await acquireBrowserProfileLock({
  profileDir,
  owner: 'validate-post-error-lock',
  timeoutMs: 0
});
postErrorLock.release();

fs.rmSync(tempDir, { recursive: true, force: true });
console.log('Browser profile lock/preflight validation passed');
