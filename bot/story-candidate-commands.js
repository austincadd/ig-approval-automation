import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { buildCandidates, buildCandidatesFromComments, buildCandidatesFused, getCandidatesSource, getCandidatesTop } from '../core/candidates.js';
import { launchBrowserSessionWithPreflight } from '../core/browser-profile.js';
import { getPipelineHealth } from '../core/pipeline.js';

export function registerStoryCandidateCommands({
  bot,
  db,
  chatId,
  requireAuthorizedChat,
  enqueueCommandTask,
  runRepoCommand
}) {
  const storyTargetsPath = path.resolve('data/story-targets.txt');
  const storyStatePath = path.resolve('data/story-state.json');
  const igCandidatesPath = path.resolve('data/ig-candidates.json');
  const profileDir = path.resolve('.browser-profile');

  let browserCtx;
  let browserPage;
  let browserLock;

  function ensureDataFiles() {
    fs.mkdirSync(path.dirname(storyTargetsPath), { recursive: true });
    if (!fs.existsSync(storyTargetsPath)) fs.writeFileSync(storyTargetsPath, '');
    if (!fs.existsSync(storyStatePath)) fs.writeFileSync(storyStatePath, JSON.stringify({ index: 0 }, null, 2));
  }

  function readStoryTargets() {
    ensureDataFiles();
    return fs.readFileSync(storyTargetsPath, 'utf8')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function writeStoryTargets(targets) {
    ensureDataFiles();
    fs.writeFileSync(storyTargetsPath, `${targets.join('\n')}\n`);
    fs.writeFileSync(storyStatePath, JSON.stringify({ index: 0 }, null, 2));
  }

  function getStoryIndex() {
    ensureDataFiles();
    try {
      return JSON.parse(fs.readFileSync(storyStatePath, 'utf8')).index || 0;
    } catch {
      return 0;
    }
  }

  function setStoryIndex(index) {
    ensureDataFiles();
    fs.writeFileSync(storyStatePath, JSON.stringify({ index }, null, 2));
  }

  function loadCandidatesDoc() {
    if (!fs.existsSync(igCandidatesPath)) return null;
    try { return JSON.parse(fs.readFileSync(igCandidatesPath, 'utf8')); } catch { return null; }
  }

  function getCandidateReviewIndex() {
    const raw = db.prepare(`SELECT value FROM system_flags WHERE key='CANDIDATE_REVIEW_INDEX'`).get()?.value;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
  }

  function setCandidateReviewIndex(index) {
    db.prepare(`
      INSERT INTO system_flags(key, value, updated_at)
      VALUES ('CANDIDATE_REVIEW_INDEX', ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')
    `).run(String(Math.max(0, Math.trunc(Number(index) || 0))));
  }

  function getCandidateReviewLabels() {
    const rows = db.prepare(`SELECT candidate_key, label FROM candidate_review_labels`).all();
    return Object.fromEntries(rows.map((r) => [r.candidate_key, r.label]));
  }

  function setCandidateReviewLabel(candidateKey, label) {
    db.prepare(`
      INSERT INTO candidate_review_labels(candidate_key, label, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(candidate_key) DO UPDATE SET label=excluded.label, updated_at=datetime('now')
    `).run(candidateKey, label);
  }

  function resetCandidateReviewState() {
    db.prepare(`DELETE FROM candidate_review_labels`).run();
    setCandidateReviewIndex(0);
  }

  function getReviewQueue() {
    const doc = loadCandidatesDoc();
    if (!doc?.candidates?.length) return { doc, queue: [], state: { index: 0, labels: {} } };
    const labels = getCandidateReviewLabels();
    const index = getCandidateReviewIndex();
    const queue = doc.candidates.filter((candidate) => {
      const label = labels?.[candidate.key];
      return label !== 'bad' && label !== 'skip';
    });
    return { doc, queue, state: { index, labels } };
  }

  function resolveCandidateAlias(target) {
    const trimmed = target.trim().toLowerCase();
    const match = trimmed.match(/^(?:ig_)?candidate_(\d+)$/i);
    if (!match) return null;
    const doc = loadCandidatesDoc();
    const idx = Number(match[1]) - 1;
    const item = doc?.candidates?.[idx];
    if (!item?.username) return null;
    return `@${item.username}`;
  }

  function parseTarget(target) {
    const aliasResolved = resolveCandidateAlias(target);
    const trimmed = (aliasResolved || target).trim();
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      const match = trimmed.match(/instagram\.com\/(?:stories\/)?([A-Za-z0-9._]+)/i);
      const username = match?.[1]?.replace(/\/$/, '');
      return {
        username: username || null,
        profileUrl: trimmed,
        storyUrl: username ? `https://www.instagram.com/stories/${username}/` : trimmed
      };
    }
    const clean = trimmed.replace(/^@/, '').replace(/\/$/, '');
    return {
      username: clean,
      profileUrl: `https://www.instagram.com/${clean}/`,
      storyUrl: `https://www.instagram.com/stories/${clean}/`
    };
  }

  async function ensureBrowserPage() {
    if (!browserCtx) {
      const session = await launchBrowserSessionWithPreflight({
        chromium,
        profileDir,
        owner: 'bot/story-candidate-commands',
        lockTimeoutMs: 0,
        headless: false,
        navigationTimeoutMs: 45000
      });
      browserCtx = session.ctx;
      browserPage = session.page;
      browserLock = session.lock;
      return browserPage;
    }
    browserPage = browserCtx.pages()[0] || await browserCtx.newPage();
    return browserPage;
  }

  async function openStoryTarget(target) {
    const page = await ensureBrowserPage();
    const { storyUrl, profileUrl } = parseTarget(target);

    await page.goto(storyUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const finalUrl = page.url();

    if (!finalUrl.includes('/stories/')) {
      await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      return { opened: profileUrl, mode: 'profile_fallback' };
    }

    return { opened: finalUrl, mode: 'story' };
  }

  function describeBrowserOpenError(err) {
    if (err?.code === 'BROWSER_PROFILE_LOCKED') {
      return `Browser profile is busy (${err.lockOwner || 'unknown owner'}). Close the other browser flow and retry.`;
    }
    if (err?.code === 'BROWSER_SESSION_NOT_READY') {
      return `Browser session is not ready: ${err.reason || err.message}. Re-login/check Instagram in the shared profile, then retry.`;
    }
    return `Story browser open failed: ${err?.message || err}`;
  }

  bot.onText(/\/stories_help/, async (msg) => {
    if (!requireAuthorizedChat(msg.chat.id)) return;
    await bot.sendMessage(chatId, [
      'Story helper commands (manual browsing only):',
      '/candidates_build <user_id_or_username> -> generate profile candidates doc',
      '/candidates_from_comments <username> [candidate_limit] [post_count] -> commenters across recent posts',
      '/candidates_fuse <username> [candidate_limit] [post_count] -> fused comments+likes+search candidates',
      '/pipeline_health <username> -> quick flashapi + looter health check',
      '/candidates_source -> show current candidate source + count',
      '/candidates_top [A|B|C] [n] -> show top scored candidates (optionally by tier)',
      '/candidates_next -> open next review candidate',
      '/candidates_skip -> mark current as skip and advance',
      '/candidates_mark_good -> mark current as good',
      '/candidates_mark_bad -> mark current as bad and advance',
      '/automation_status -> queue counts, pending approvals, recent blocked jobs',
      '/pause_automation [reason] -> stop the worker from processing new jobs',
      '/resume_automation [reason] -> re-enable job processing',
      '/requeue_blocked [reason] -> create fresh queued jobs for blocked candidates that are safe to retry',
      '/reconcile_queue [reason] -> backfill queued jobs for approved candidates missing active/success jobs',
      '/stories_set @user1 @user2 ...  -> set target list',
      '/stories_list -> show current targets',
      '/stories_start -> open first target in saved browser profile',
      '/stories_next -> open next target',
      '/stories_open @username -> open a specific profile/url',
      '/stories_open IG_candidate_1 -> open candidate alias from data/ig-candidates.json'
    ].join('\n'));
  });

  bot.onText(/\/stories_set(?:\s+(.+))?/, async (msg, match) => {
    if (!requireAuthorizedChat(msg.chat.id)) return;
    const raw = (match?.[1] || '').trim();
    if (!raw) {
      await bot.sendMessage(chatId, 'Usage: /stories_set @user1 @user2 ...');
      return;
    }
    const targets = raw.split(/\s+/).map((s) => s.trim()).filter(Boolean);
    writeStoryTargets(targets);
    await bot.sendMessage(chatId, `Saved ${targets.length} story targets.`);
  });

  bot.onText(/\/candidates_from_comments(?:\s+(.+))?/, async (msg, match) => {
    if (!requireAuthorizedChat(msg.chat.id)) return;
    const raw = (match?.[1] || '').trim();
    if (!raw) {
      await bot.sendMessage(chatId, 'Usage: /candidates_from_comments <username> [candidate_limit] [post_count]');
      return;
    }
    const [username, limitRaw, postCountRaw] = raw.split(/\s+/);
    const limit = Number(limitRaw || 30);
    const postCount = Number(postCountRaw || 3);

    const result = await enqueueCommandTask(() => buildCandidatesFromComments(
      { username, candidateLimit: limit, postCount },
      {
        runCommand: (cmd, args) => runRepoCommand(cmd, args, 90000),
        resetState: () => resetCandidateReviewState(),
        candidatesFile: igCandidatesPath,
        readJsonFile: (absPath) => JSON.parse(fs.readFileSync(absPath, 'utf8'))
      }
    ));
    if (result.status === 'error') {
      await bot.sendMessage(chatId, `Commenter candidate build failed: ${result.detail || result.message}`);
      return;
    }
    if (result.status === 'degraded') {
      await bot.sendMessage(chatId, `Commenter candidate build degraded: ${result.reason} — ${result.detail}`);
      return;
    }
    await bot.sendMessage(chatId, `Built commenter candidates from ${username}. count=${result.count} source=${result.source}`);
  });

  bot.onText(/\/candidates_fuse(?:\s+(.+))?/, async (msg, match) => {
    if (!requireAuthorizedChat(msg.chat.id)) return;
    const raw = (match?.[1] || '').trim();
    if (!raw) {
      await bot.sendMessage(chatId, 'Usage: /candidates_fuse <username> [candidate_limit] [post_count]');
      return;
    }
    const [username, limitRaw, postCountRaw] = raw.split(/\s+/);
    const limit = Number(limitRaw || 40);
    const postCount = Number(postCountRaw || 3);

    const result = await enqueueCommandTask(() => buildCandidatesFused(
      { username, candidateLimit: limit, postCount },
      {
        runCommand: (cmd, args) => runRepoCommand(cmd, args, 90000),
        resetState: () => resetCandidateReviewState(),
        candidatesFile: igCandidatesPath,
        readJsonFile: (absPath) => JSON.parse(fs.readFileSync(absPath, 'utf8'))
      }
    ));
    if (result.status === 'error') {
      await bot.sendMessage(chatId, `Fused candidate build failed: ${result.detail || result.message}`);
      return;
    }
    if (result.status === 'degraded') {
      await bot.sendMessage(chatId, `Fused candidate build degraded: ${result.reason} — ${result.detail}`);
      return;
    }
    await bot.sendMessage(chatId, `Built fused candidates from ${username}. count=${result.count} source=${result.source}`);
  });

  bot.onText(/\/candidates_build(?:\s+(.+))?/, async (msg, match) => {
    if (!requireAuthorizedChat(msg.chat.id)) return;
    const ref = (match?.[1] || '').trim();
    if (!ref) {
      await bot.sendMessage(chatId, 'Usage: /candidates_build <user_id_or_username>');
      return;
    }

    const result = await enqueueCommandTask(() => buildCandidates(
      { ref },
      {
        runCommand: (cmd, args) => runRepoCommand(cmd, args, 90000),
        resetState: () => resetCandidateReviewState(),
        candidatesFile: igCandidatesPath,
        readJsonFile: (absPath) => JSON.parse(fs.readFileSync(absPath, 'utf8'))
      }
    ));
    if (result.status === 'error') {
      await bot.sendMessage(chatId, `Candidate build failed: ${result.detail || result.message}`);
      return;
    }
    if (result.status === 'degraded') {
      await bot.sendMessage(chatId, `Candidate build degraded: ${result.reason} — ${result.detail}`);
      return;
    }
    await bot.sendMessage(chatId, `Built candidates from ref ${ref}. count=${result.count} source=${result.source}`);
  });

  bot.onText(/\/pipeline_health(?:\s+(.+))?/, async (msg, match) => {
    if (!requireAuthorizedChat(msg.chat.id)) return;
    const seed = (match?.[1] || '').trim() || 'instagram';

    const result = await enqueueCommandTask(() => getPipelineHealth(
      { seedUsername: seed },
      {
        runCommand: (cmd, args) => runRepoCommand(cmd, args, 30000)
      }
    ));

    const checks = (result.checks || []).map((check) => check.summary);
    await bot.sendMessage(chatId, checks.join('\n'));
  });

  bot.onText(/\/candidates_source/, async (msg) => {
    if (!requireAuthorizedChat(msg.chat.id)) return;
    const result = getCandidatesSource(
      {},
      {
        candidatesFile: igCandidatesPath,
        readJsonFile: (absPath) => JSON.parse(fs.readFileSync(absPath, 'utf8'))
      }
    );

    if (result.status === 'error') {
      await bot.sendMessage(chatId, 'No candidate file yet. Run /candidates_build <user_id_or_username> first.');
      return;
    }

    const data = result.data;
    await bot.sendMessage(
      chatId,
      [
        `Input ref: ${data.inputRef || 'n/a'}`,
        `Source user id: ${data.sourceUserId || 'n/a'}`,
        `Candidate source: ${data.candidateSource || 'unknown'}`,
        `Count: ${data.count ?? 'n/a'}`,
        data.tierCounts ? `Tiers: A=${data.tierCounts.A} B=${data.tierCounts.B} C=${data.tierCounts.C}` : '',
        data.likeTierCounts ? `Like tiers: A=${data.likeTierCounts.A} B=${data.likeTierCounts.B} C=${data.likeTierCounts.C}` : '',
        data.commentTierCounts ? `Comment tiers: A=${data.commentTierCounts.A} B=${data.commentTierCounts.B} C=${data.commentTierCounts.C}` : ''
      ].filter(Boolean).join('\n')
    );
  });

  bot.onText(/\/candidates_top(?:\s+(.+))?/, async (msg, match) => {
    if (!requireAuthorizedChat(msg.chat.id)) return;
    const raw = (match?.[1] || '').trim();
    const parts = raw ? raw.split(/\s+/) : [];
    let tier;
    let n;

    for (const part of parts) {
      if (/^[ABCabc]$/.test(part)) tier = part.toUpperCase();
      else if (/^\d+$/.test(part)) n = Number(part);
    }

    const result = getCandidatesTop(
      { tier, limit: n },
      {
        candidatesFile: igCandidatesPath,
        readJsonFile: (absPath) => JSON.parse(fs.readFileSync(absPath, 'utf8'))
      }
    );

    if (result.status === 'error') {
      await bot.sendMessage(chatId, 'No candidates yet. Run /candidates_build or /candidates_fuse first.');
      return;
    }

    const lines = result.items.map((candidate) => `${candidate.rank}. ${candidate.key} @${candidate.username} tier=${candidate.tier} like=${candidate.likeTier} comment=${candidate.commentTier} score=${candidate.score}`);
    if (!lines.length) {
      await bot.sendMessage(chatId, result.tierFilter ? `No candidates in tier ${result.tierFilter}.` : 'No candidates found.');
      return;
    }
    await bot.sendMessage(chatId, lines.join('\n'));
  });

  bot.onText(/\/candidates_next/, async (msg) => {
    if (!requireAuthorizedChat(msg.chat.id)) return;
    const { queue, state } = getReviewQueue();
    if (!queue?.length) {
      await bot.sendMessage(chatId, 'No reviewable candidates.');
      return;
    }
    let idx = Number(state?.index || 0);
    if (idx >= queue.length) idx = 0;
    const candidate = queue[idx];
    setCandidateReviewIndex(idx);
    try {
      const result = await openStoryTarget(`@${candidate.username}`);
      await bot.sendMessage(chatId, `Opened ${candidate.key} @${candidate.username} score=${candidate.score ?? 0} (${result.mode})`);
    } catch (err) {
      await bot.sendMessage(chatId, describeBrowserOpenError(err));
    }
  });

  bot.onText(/\/candidates_skip/, async (msg) => {
    if (!requireAuthorizedChat(msg.chat.id)) return;
    const { queue, state } = getReviewQueue();
    if (!queue?.length) { await bot.sendMessage(chatId, 'No reviewable candidates.'); return; }
    let idx = Number(state?.index || 0);
    if (idx >= queue.length) idx = 0;
    const current = queue[idx];
    setCandidateReviewLabel(current.key, 'skip');
    setCandidateReviewIndex(idx + 1);
    await bot.sendMessage(chatId, `Skipped ${current.key}. Use /candidates_next.`);
  });

  bot.onText(/\/candidates_mark_good/, async (msg) => {
    if (!requireAuthorizedChat(msg.chat.id)) return;
    const { queue, state } = getReviewQueue();
    if (!queue?.length) { await bot.sendMessage(chatId, 'No reviewable candidates.'); return; }
    let idx = Number(state?.index || 0);
    if (idx >= queue.length) idx = 0;
    const current = queue[idx];
    setCandidateReviewLabel(current.key, 'good');
    setCandidateReviewIndex(idx);
    await bot.sendMessage(chatId, `Marked good: ${current.key}`);
  });

  bot.onText(/\/candidates_mark_bad/, async (msg) => {
    if (!requireAuthorizedChat(msg.chat.id)) return;
    const { queue, state } = getReviewQueue();
    if (!queue?.length) { await bot.sendMessage(chatId, 'No reviewable candidates.'); return; }
    let idx = Number(state?.index || 0);
    if (idx >= queue.length) idx = 0;
    const current = queue[idx];
    setCandidateReviewLabel(current.key, 'bad');
    setCandidateReviewIndex(idx + 1);
    await bot.sendMessage(chatId, `Marked bad: ${current.key}. Use /candidates_next.`);
  });

  bot.onText(/\/stories_list/, async (msg) => {
    if (!requireAuthorizedChat(msg.chat.id)) return;
    const targets = readStoryTargets();
    if (!targets.length) {
      await bot.sendMessage(chatId, 'No story targets set. Use /stories_set @user1 @user2');
      return;
    }
    const idx = getStoryIndex();
    const lines = targets.map((target, i) => `${i === idx ? '➡️ ' : ''}${i + 1}. ${target}`);
    await bot.sendMessage(chatId, lines.join('\n'));
  });

  bot.onText(/\/stories_start/, async (msg) => {
    if (!requireAuthorizedChat(msg.chat.id)) return;
    const targets = readStoryTargets();
    if (!targets.length) {
      await bot.sendMessage(chatId, 'No story targets set. Use /stories_set first.');
      return;
    }
    setStoryIndex(0);
    try {
      const result = await openStoryTarget(targets[0]);
      await bot.sendMessage(chatId, `Opened #1 (${result.mode}): ${result.opened}`);
    } catch (err) {
      await bot.sendMessage(chatId, describeBrowserOpenError(err));
    }
  });

  bot.onText(/\/stories_next/, async (msg) => {
    if (!requireAuthorizedChat(msg.chat.id)) return;
    const targets = readStoryTargets();
    if (!targets.length) {
      await bot.sendMessage(chatId, 'No story targets set. Use /stories_set first.');
      return;
    }
    let idx = getStoryIndex() + 1;
    if (idx >= targets.length) idx = 0;
    setStoryIndex(idx);
    try {
      const result = await openStoryTarget(targets[idx]);
      await bot.sendMessage(chatId, `Opened #${idx + 1} (${result.mode}): ${result.opened}`);
    } catch (err) {
      await bot.sendMessage(chatId, describeBrowserOpenError(err));
    }
  });

  bot.onText(/\/stories_open(?:\s+(.+))?/, async (msg, match) => {
    if (!requireAuthorizedChat(msg.chat.id)) return;
    const target = (match?.[1] || '').trim();
    if (!target) {
      await bot.sendMessage(chatId, 'Usage: /stories_open @username | /stories_open https://instagram.com/... | /stories_open IG_candidate_1');
      return;
    }
    try {
      const result = await openStoryTarget(target);
      await bot.sendMessage(chatId, `Opened (${result.mode}): ${result.opened}`);
    } catch (err) {
      await bot.sendMessage(chatId, describeBrowserOpenError(err));
    }
  });

  return {
    closeResources: async () => {
      try { await browserCtx?.close(); } catch {}
      try { browserLock?.release(); } catch {}
      browserCtx = null;
      browserPage = null;
      browserLock = null;
    }
  };
}
