#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const username = (process.argv[2] || '').replace(/^@/, '').trim();
const maxCount = Math.min(Number(process.argv[3] || 30), 100);
const postCount = Math.min(Number(process.argv[4] || 3), 10);

if (!username) {
  console.error('Usage: node scripts/build-ig-candidates-from-comments.js <username> [maxCount] [postCount]');
  process.exit(1);
}

function run(cmd, args) {
  return execFileSync(cmd, args, { cwd: root, encoding: 'utf8' });
}

function parseJsonOrDie(raw, label) {
  try { return JSON.parse(raw); }
  catch {
    console.error(`Could not parse ${label} response as JSON.`);
    console.error(raw);
    process.exit(1);
  }
}

function extractRecentShortcodes(postsPayload, count) {
  const items = postsPayload?.items || postsPayload?.data?.items || [];
  if (!Array.isArray(items) || !items.length) return [];
  return items
    .map((it) => it?.code || it?.shortcode || null)
    .filter(Boolean)
    .slice(0, count);
}

function extractCommentUsers(commentsPayload) {
  const comments = commentsPayload?.comments || commentsPayload?.items || commentsPayload?.data?.comments || [];
  if (!Array.isArray(comments)) return [];

  const acc = new Map();
  for (const c of comments) {
    const userObj = c?.user || {};
    const uname = (c?.username || userObj?.username || c?.owner_username || '').trim();
    if (!uname) continue;
    const key = uname.toLowerCase();
    const prev = acc.get(key) || {
      username: uname,
      id: userObj?.id || userObj?.pk || null,
      full_name: userObj?.full_name || null,
      is_verified: userObj?.is_verified ?? null,
      mentions: 0,
      total_comment_likes: 0,
      posts_commented: new Set()
    };
    prev.mentions += 1;
    prev.total_comment_likes += Number(c?.comment_like_count || 0);
    acc.set(key, prev);
  }

  return Array.from(acc.values());
}

function score(u, seed) {
  let s = 0;
  const reasons = [];

  if (u.posts_commented_count >= 3) { s += 30; reasons.push('commented across 3+ posts'); }
  else if (u.posts_commented_count === 2) { s += 20; reasons.push('commented across 2 posts'); }
  else if (u.posts_commented_count === 1) { s += 8; reasons.push('commented on recent post'); }

  if (u.mentions >= 4) { s += 16; reasons.push('high comment frequency'); }
  else if (u.mentions >= 2) { s += 8; reasons.push('multiple comments'); }

  if (u.total_comment_likes >= 10) { s += 10; reasons.push('liked comments'); }
  if (u.is_verified) { s += 12; reasons.push('verified'); }
  if (u.username.toLowerCase().includes(seed.toLowerCase())) { s += 8; reasons.push('username matches seed'); }
  return { score: s, reasons };
}

const postsRaw = run('./scripts/flash-mcp.sh', ['user-posts-username', username]);
const posts = parseJsonOrDie(postsRaw, 'user-posts');
const shortcodes = extractRecentShortcodes(posts, postCount);

if (!shortcodes.length) {
  console.error('No recent posts/shortcodes found for that username.');
  process.exit(1);
}

const merged = new Map();
for (const shortcode of shortcodes) {
  const commentsRaw = run('./scripts/flash-mcp.sh', ['media-comments', shortcode]);
  const comments = parseJsonOrDie(commentsRaw, `media-comments (${shortcode})`);
  const users = extractCommentUsers(comments);

  for (const u of users) {
    const key = u.username.toLowerCase();
    const prev = merged.get(key) || {
      username: u.username,
      id: u.id,
      full_name: u.full_name,
      is_verified: u.is_verified,
      mentions: 0,
      total_comment_likes: 0,
      posts_commented: new Set()
    };
    prev.mentions += u.mentions;
    prev.total_comment_likes += u.total_comment_likes;
    prev.posts_commented.add(shortcode);
    merged.set(key, prev);
  }
}

let users = Array.from(merged.values())
  .filter((u) => u.username.toLowerCase() !== username.toLowerCase())
  .map((u) => ({ ...u, posts_commented_count: u.posts_commented.size }));

users = users
  .map((u) => ({ ...u, ...score(u, username) }))
  .sort((a, b) => (b.score - a.score) || (b.posts_commented_count - a.posts_commented_count) || (b.mentions - a.mentions) || a.username.localeCompare(b.username))
  .slice(0, maxCount)
  .map((u) => ({ ...u, posts_commented: undefined }));

const generatedAt = new Date().toISOString();
const doc = {
  input_ref: username,
  source_user_id: null,
  source_username: username,
  generated_at: generatedAt,
  candidate_source: 'recent_posts_commenters',
  seed_shortcodes: shortcodes,
  scanned_posts: shortcodes.length,
  count: users.length,
  candidates: users.map((u, i) => ({
    key: `candidate_${i + 1}`,
    id: u.id ? String(u.id) : null,
    username: u.username,
    full_name: u.full_name,
    is_verified: u.is_verified,
    score: u.score,
    score_reasons: u.reasons,
    mentions: u.mentions,
    posts_commented_count: u.posts_commented_count,
    total_comment_likes: u.total_comment_likes,
    profile_url: `https://www.instagram.com/${u.username}/`,
    story_url: `https://www.instagram.com/stories/${u.username}/`
  }))
};

const jsonPath = path.join(root, 'data', 'ig-candidates.json');
const mdPath = path.join(root, 'data', 'ig-candidates.md');
fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
fs.writeFileSync(jsonPath, JSON.stringify(doc, null, 2));

const lines = [
  '# IG Candidates',
  '',
  `- Input ref: ${doc.input_ref}`,
  `- Source username: ${doc.source_username}`,
  `- Generated at: ${doc.generated_at}`,
  `- Candidate source: ${doc.candidate_source}`,
  `- Scanned posts: ${doc.scanned_posts}`,
  `- Seed shortcodes: ${doc.seed_shortcodes.join(', ')}`,
  `- Count: ${doc.count}`,
  '',
  '## Candidates',
  ''
];
for (const c of doc.candidates) {
  lines.push(`- ${c.key}: @${c.username} score=${c.score} posts=${c.posts_commented_count} mentions=${c.mentions}`);
}
if (!doc.candidates.length) lines.push('- No commenters found on the recent posts scanned.');
fs.writeFileSync(mdPath, `${lines.join('\n')}\n`);

console.log(`Saved ${doc.count} candidates from comments across ${doc.scanned_posts} posts:`);
console.log(`- ${jsonPath}`);
console.log(`- ${mdPath}`);
