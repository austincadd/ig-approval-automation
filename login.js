import { chromium } from 'playwright';
import { acquireBrowserProfileLock } from './core/browser-profile.js';

const lock = await acquireBrowserProfileLock({
  profileDir: '.browser-profile',
  owner: 'login.js',
  timeoutMs: 0
}).catch((err) => {
  if (err?.code === 'BROWSER_PROFILE_LOCKED') {
    console.error(`Browser profile is busy (${err.lockOwner || 'unknown owner'}). Close the other browser flow and retry.`);
    process.exit(1);
  }
  throw err;
});

const ctx = await chromium.launchPersistentContext(lock.profileDir, { headless: false });
const page = ctx.pages()[0] || await ctx.newPage();
await page.goto('https://www.instagram.com/');
console.log('Log in, then close the browser window.');

ctx.on('close', () => {
  try { lock.release(); } catch {}
  process.exit(0);
});
