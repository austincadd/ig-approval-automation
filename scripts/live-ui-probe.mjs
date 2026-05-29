import Database from 'better-sqlite3';
import { chromium } from 'playwright';
import { launchBrowserSessionWithPreflight } from '../core/browser-profile.js';
import { classifyPageShape } from '../worker/page-shape.js';
import { waitForPrimaryActionControlWithRetry } from '../worker/selectors.js';

const db = new Database('data/ig_automation.db', { readonly: true });
const urls = db.prepare(`
  select distinct c.id, c.post_url,
    coalesce((select lj.status from like_jobs lj where lj.candidate_id=c.id order by lj.id desc limit 1), 'none') as last_status,
    coalesce((select lj.error_code from like_jobs lj where lj.candidate_id=c.id order by lj.id desc limit 1), '') as last_error
  from candidates c
  where c.id in (5,6,7,8,9)
  order by c.id asc
`).all();

const browserSession = await launchBrowserSessionWithPreflight({
  chromium,
  profileDir: '.browser-profile',
  owner: 'live-ui-probe',
  lockTimeoutMs: 0,
  headless: false,
  navigationTimeoutMs: 30000
});

const { ctx, page, lock } = browserSession;
const results = [];
try {
  for (const row of urls) {
    const started = Date.now();
    const result = { id: row.id, url: row.post_url, last_status: row.last_status, last_error: row.last_error };
    try {
      await page.goto(row.post_url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2500);
      const shape = await classifyPageShape(page);
      const control = await waitForPrimaryActionControlWithRetry(page, { timeoutMs: 5000 });
      result.ok = true;
      result.elapsed_ms = Date.now() - started;
      result.page_shape = shape.shape;
      result.shape_reason = shape.reason;
      result.control_ok = control.ok;
      result.control_state = control.state;
      result.control_attempts = control.attempts;
      result.control_descriptor = control.descriptor ? {
        tag: control.descriptor.tag,
        aria: control.descriptor.aria,
        x: control.descriptor.x,
        y: control.descriptor.y,
        w: control.descriptor.w,
        h: control.descriptor.h
      } : null;
      result.row = control.row ? {
        orientation: control.row.orientation,
        supportCount: control.row.supportCount,
        state: control.row.state,
        labels: control.row.labels,
        layoutFamily: control.row.layoutFamily
      } : null;
      result.candidate_count = control.candidates?.length || 0;
    } catch (error) {
      result.ok = false;
      result.elapsed_ms = Date.now() - started;
      result.error = error?.message || String(error);
    }
    results.push(result);
  }
} finally {
  await ctx.close().catch(() => {});
  lock.release();
}
console.log(JSON.stringify(results, null, 2));
