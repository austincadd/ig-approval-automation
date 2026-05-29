#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const username = (process.argv[2] || '').replace(/^@/, '').trim();
const maxCount = Math.min(Number(process.argv[3] || 40), 150);
const postCount = Math.min(Number(process.argv[4] || 3), 8);

if (!username) {
  console.error('Usage: node scripts/build-ig-candidates-fused.js <username> [maxCount] [postCount]');
  process.exit(1);
}

const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8' });
const parseJson = (raw, label) => {
  try { return JSON.parse(raw); }
  catch { throw new Error(`Failed parsing ${label} JSON`); }
};

const getMessage = (payload) => String(payload?.message || payload?.error || '').toLowerCase();
const isFlashQuotaError = (payload) => getMessage(payload).includes('exceeded the monthly quota');
const isInvalidIdError = (payload) => getMessage(payload).includes('invalid id_user format');

const SPAM_PATTERNS = [
  /follow\s*4\s*follow/i,
  /f4f/i,
  /giveaway/i,
  /dm\s*(me|for)/i,
  /crypto/i,
  /airdrop/i,
  /bet/i,
  /promo/i,
  /advert/i,
  /onlyfans/i,
  /free\s+followers/i,
];

function looksLowQuality(candidate) {
  const text = `${candidate.username || ''} ${candidate.full_name || ''}`;
  if (SPAM_PATTERNS.some((rx) => rx.test(text))) return true;
  if ((candidate.username || '').replace(/[^0-9]/g, '').length >= 6) return true;
  return false;
}

function assignTier(score) {
  if (score >= 55) return 'A';
  if (score >= 32) return 'B';
  return 'C';
}

function assignLikeTier(likeHits) {
  if (likeHits >= 3) return 'A';
  if (likeHits >= 1) return 'B';
  return 'C';
}

function assignCommentTier(mentions) {
  if (mentions >= 4) return 'A';
  if (mentions >= 1) return 'B';
  return 'C';
}

const upsert = (map, uname, patch) => {
  const key = uname.toLowerCase();
  const prev = map.get(key) || {
    username: uname,
    id: null,
    full_name: null,
    is_verified: null,
    mentions: 0,
    total_comment_likes: 0,
    like_hits: 0,
    sources: new Set()
  };
  const next = { ...prev, ...patch };
  if (prev.sources) next.sources = prev.sources;
  map.set(key, next);
  return next;
};

function buildLooterFallbackCandidates() {
  const out = new Map();
  try {
    const searchPayload = parseJson(run('./scripts/ig-mcp.sh', ['search-users', username, 'users']), 'search-users');
    const users = searchPayload?.users || searchPayload?.data?.users || [];
    for (const row of users.slice(0, 80)) {
      const u = row?.user || row;
      const uname = (u?.username || '').trim();
      if (!uname || uname.toLowerCase() === username.toLowerCase()) continue;
      const entry = upsert(out, uname, {
        id: u?.id || u?.pk || null,
        full_name: u?.full_name || null,
        is_verified: u?.is_verified ?? null
      });
      entry.sources.add('search');
    }
  } catch {}

  // Try related profiles from first search hit ID for extra graph signal.
  try {
    const seed = Array.from(out.values())[0];
    if (seed?.id) {
      const relatedPayload = parseJson(run('./scripts/ig-mcp.sh', ['related', String(seed.id)]), 'related');
      const buckets = [
        relatedPayload?.data?.users,
        relatedPayload?.data?.related_profiles,
        relatedPayload?.data?.items,
        relatedPayload?.data?.viewer,
      ].filter(Boolean);
      const rows = buckets.flatMap((b) => Array.isArray(b) ? b : []);
      for (const row of rows) {
        const u = row?.user || row;
        const uname = (u?.username || '').trim();
        if (!uname || uname.toLowerCase() === username.toLowerCase()) continue;
        const entry = upsert(out, uname, {
          id: u?.id || u?.pk || null,
          full_name: u?.full_name || null,
          is_verified: u?.is_verified ?? null
        });
        entry.sources.add('related');
      }
    }
  } catch {}

  return out;
}

let shortcodes = [];
let flashBlockedReason = null;
try {
  const posts = parseJson(run('./scripts/flash-mcp.sh', ['user-posts-username', username]), 'user-posts-username');
  if (isFlashQuotaError(posts)) flashBlockedReason = 'flashapi_monthly_quota_exceeded';
  if (isInvalidIdError(posts)) flashBlockedReason = 'flashapi_invalid_id_format';
  const items = posts?.items || [];
  shortcodes = items.map(i => i?.code || i?.shortcode).filter(Boolean).slice(0, postCount);
} catch {
  flashBlockedReason = 'flashapi_unavailable';
}

const candidates = (!shortcodes.length && flashBlockedReason)
  ? buildLooterFallbackCandidates()
  : new Map();

for (const sc of shortcodes) {
  // comments
  try {
    const commentsPayload = parseJson(run('./scripts/flash-mcp.sh', ['media-comments', sc]), `comments ${sc}`);
    const comments = commentsPayload?.comments || [];
    for (const c of comments) {
      const u = c?.user || {};
      const uname = (c?.username || u?.username || c?.owner_username || '').trim();
      if (!uname || uname.toLowerCase() === username.toLowerCase()) continue;
      const entry = upsert(candidates, uname, {
        id: u?.id || u?.pk || null,
        full_name: u?.full_name || null,
        is_verified: u?.is_verified ?? null
      });
      entry.mentions += 1;
      entry.total_comment_likes += Number(c?.comment_like_count || 0);
      entry.sources.add('comments');
    }
  } catch {}

  // likes
  try {
    const likesPayload = parseJson(run('./scripts/flash-mcp.sh', ['media', sc]), `media ${sc}`);
    const sections = [likesPayload?.likers, likesPayload?.likes, likesPayload?.users, likesPayload?.data?.likers].filter(Boolean);
    const likers = sections.flatMap(s => Array.isArray(s) ? s : []);
    for (const l of likers) {
      const u = l?.user || l;
      const uname = (u?.username || '').trim();
      if (!uname || uname.toLowerCase() === username.toLowerCase()) continue;
      const entry = upsert(candidates, uname, {
        id: u?.id || u?.pk || null,
        full_name: u?.full_name || null,
        is_verified: u?.is_verified ?? null
      });
      entry.like_hits += 1;
      entry.sources.add('likes');
    }
  } catch {}
}

// keyword neighborhood via search fallback
try {
  const searchPayload = parseJson(run('./scripts/ig-mcp.sh', ['search-users', username, 'users']), 'search-users');
  const users = searchPayload?.users || searchPayload?.data?.users || [];
  for (const row of users.slice(0, 30)) {
    const u = row?.user || row;
    const uname = (u?.username || '').trim();
    if (!uname || uname.toLowerCase() === username.toLowerCase()) continue;
    const entry = upsert(candidates, uname, {
      id: u?.id || u?.pk || null,
      full_name: u?.full_name || null,
      is_verified: u?.is_verified ?? null
    });
    entry.sources.add('search');
  }
} catch {}

const scored = Array.from(candidates.values())
  .filter((c) => !looksLowQuality(c))
  .map((c) => {
    let score = 0;
    const reasons = [];

    if (c.mentions >= 4) { score += 34; reasons.push('high-comment-intent'); }
    else if (c.mentions >= 2) { score += 22; reasons.push('multi-comments'); }
    else if (c.mentions >= 1) { score += 12; reasons.push('commenter'); }

    if (c.like_hits >= 2) { score += 12; reasons.push('repeated-liker'); }
    else if (c.like_hits >= 1) { score += 7; reasons.push('liker'); }

    const sourceCount = (c.sources?.size || 0);
    if (sourceCount >= 3) { score += 26; reasons.push('3-source-agreement'); }
    else if (sourceCount === 2) { score += 18; reasons.push('2-source-agreement'); }

    if (c.is_verified) { score += 10; reasons.push('verified'); }
    if (c.total_comment_likes >= 20) { score += 10; reasons.push('high-liked-comments'); }
    else if (c.total_comment_likes >= 10) { score += 6; reasons.push('liked-comments'); }

    if (c.username.toLowerCase().includes(username.toLowerCase())) { score += 6; reasons.push('seed-match'); }

    const tier = assignTier(score);
    const like_tier = assignLikeTier(c.like_hits || 0);
    const comment_tier = assignCommentTier(c.mentions || 0);
    return { ...c, score, tier, like_tier, comment_tier, score_reasons: reasons, sources: Array.from(c.sources || []) };
  })
  .sort((a,b)=> b.score-a.score || b.mentions-a.mentions || a.username.localeCompare(b.username))
  .slice(0, maxCount);

const candidateSource = flashBlockedReason
  ? `ig_looter_fallback (${flashBlockedReason})`
  : 'fused_comments_likes_search';

const doc = {
  input_ref: username,
  source_username: username,
  generated_at: new Date().toISOString(),
  candidate_source: candidateSource,
  scanned_posts: shortcodes.length,
  seed_shortcodes: shortcodes,
  count: scored.length,
  tier_counts: {
    A: scored.filter((c) => c.tier === 'A').length,
    B: scored.filter((c) => c.tier === 'B').length,
    C: scored.filter((c) => c.tier === 'C').length,
  },
  like_tier_counts: {
    A: scored.filter((c) => c.like_tier === 'A').length,
    B: scored.filter((c) => c.like_tier === 'B').length,
    C: scored.filter((c) => c.like_tier === 'C').length,
  },
  comment_tier_counts: {
    A: scored.filter((c) => c.comment_tier === 'A').length,
    B: scored.filter((c) => c.comment_tier === 'B').length,
    C: scored.filter((c) => c.comment_tier === 'C').length,
  },
  candidates: scored.map((u,i)=>({
    key: `candidate_${i+1}`,
    id: u.id ? String(u.id) : null,
    username: u.username,
    full_name: u.full_name,
    is_verified: u.is_verified,
    score: u.score,
    tier: u.tier,
    like_tier: u.like_tier,
    comment_tier: u.comment_tier,
    score_reasons: u.score_reasons,
    mentions: u.mentions,
    like_hits: u.like_hits,
    sources: u.sources,
    total_comment_likes: u.total_comment_likes,
    profile_url: `https://www.instagram.com/${u.username}/`,
    story_url: `https://www.instagram.com/stories/${u.username}/`
  }))
};

const jsonPath = path.join(root, 'data', 'ig-candidates.json');
const mdPath = path.join(root, 'data', 'ig-candidates.md');
fs.writeFileSync(jsonPath, JSON.stringify(doc, null, 2));
const lines = [
  '# IG Candidates', '',
  `- Input ref: ${doc.input_ref}`,
  `- Candidate source: ${doc.candidate_source}`,
  `- Scanned posts: ${doc.scanned_posts}`,
  `- Count: ${doc.count}`,
  `- Tier counts: A=${doc.tier_counts.A} B=${doc.tier_counts.B} C=${doc.tier_counts.C}`,
  `- Like tiers: A=${doc.like_tier_counts.A} B=${doc.like_tier_counts.B} C=${doc.like_tier_counts.C}`,
  `- Comment tiers: A=${doc.comment_tier_counts.A} B=${doc.comment_tier_counts.B} C=${doc.comment_tier_counts.C}`,
  '', '## Candidates', ''
];
for (const c of doc.candidates) lines.push(`- ${c.key}: @${c.username} tier=${c.tier} like_tier=${c.like_tier} comment_tier=${c.comment_tier} score=${c.score} src=${c.sources.join('+')} comments=${c.mentions} likes=${c.like_hits}`);
if (!doc.candidates.length) lines.push('- No candidates generated.');
fs.writeFileSync(mdPath, `${lines.join('\n')}\n`);

console.log(`Saved ${doc.count} fused candidates:`);
console.log(`- source: ${doc.candidate_source}`);
console.log(`- tiers: A=${doc.tier_counts.A} B=${doc.tier_counts.B} C=${doc.tier_counts.C}`);
console.log(`- like_tiers: A=${doc.like_tier_counts.A} B=${doc.like_tier_counts.B} C=${doc.like_tier_counts.C}`);
console.log(`- comment_tiers: A=${doc.comment_tier_counts.A} B=${doc.comment_tier_counts.B} C=${doc.comment_tier_counts.C}`);
console.log(`- ${jsonPath}`);
console.log(`- ${mdPath}`);
