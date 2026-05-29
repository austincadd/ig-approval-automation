#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const inputRef = process.argv[2];
const maxCount = Number(process.argv[3] || 20);

if (!inputRef) {
  console.error('Usage: node scripts/build-ig-candidates.js <user_id_or_username> [maxCount]');
  process.exit(1);
}

function run(cmd, args) {
  return execFileSync(cmd, args, { cwd: root, encoding: 'utf8' });
}

function resolveUserId(ref) {
  if (/^\d+$/.test(ref)) {
    return { userId: ref, sourceUsername: null };
  }

  const username = ref.replace(/^@/, '').trim();
  const raw = run('./scripts/flash-mcp.sh', ['user-id', username]);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error('Could not parse user-id response as JSON. Raw output:');
    console.error(raw);
    process.exit(1);
  }

  const userId = parsed?.id || parsed?.data?.id || parsed?.data?.user_id || parsed?.user_id || null;
  if (!userId) {
    console.error(`Could not resolve user id from username: ${username}`);
    process.exit(1);
  }

  return { userId: String(userId), sourceUsername: username };
}

function extractCursor(payload) {
  return payload?.next_max_id || payload?.data?.next_max_id || payload?.next || payload?.data?.next || null;
}

function normalizeProfiles(payload, sourceUserId) {
  const data = payload?.data || payload || {};

  const buckets = [
    data?.users,
    data?.followers,
    data?.items,
    data?.viewer,
    data?.users_data,
    data?.result,
    payload?.users,
    payload?.followers,
    payload?.items,
  ].filter(Boolean);

  const flattened = buckets.flatMap((b) => Array.isArray(b) ? b : []);

  const out = [];
  for (const entryRaw of flattened) {
    const entry = entryRaw?.user || entryRaw;
    const username = entry?.username || entry?.pk_username || null;
    const id = entry?.id || entry?.pk || entry?.user_id || null;
    if (!username) continue;
    out.push({
      id: id ? String(id) : null,
      username,
      full_name: entry?.full_name || null,
      is_verified: entry?.is_verified ?? null,
      follower_count: entry?.follower_count ?? null,
      source_user_id: String(sourceUserId)
    });
  }

  const map = new Map();
  for (const p of out) map.set(p.username.toLowerCase(), p);
  return Array.from(map.values());
}

const { userId, sourceUsername } = resolveUserId(inputRef);

let profiles = [];
let nextMaxId = '';
let pageSafety = 0;

while (profiles.length < maxCount && pageSafety < 8) {
  const args = ['followers', String(userId)];
  if (nextMaxId) args.push(String(nextMaxId));
  const raw = run('./scripts/flash-mcp.sh', args);

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error('Could not parse followers response as JSON. Raw output:');
    console.error(raw);
    process.exit(1);
  }

  const pageProfiles = normalizeProfiles(parsed, userId);
  profiles.push(...pageProfiles);
  nextMaxId = extractCursor(parsed) || '';

  pageSafety += 1;
  if (!nextMaxId || !pageProfiles.length) break;
}

// dedupe + remove source profile if present
const seedUsername = (sourceUsername || String(inputRef).replace(/^@/, '')).toLowerCase();
const deduped = new Map();
for (const p of profiles) {
  if (p.username.toLowerCase() === seedUsername) continue;
  deduped.set(p.username.toLowerCase(), p);
}
profiles = Array.from(deduped.values()).slice(0, maxCount);
let candidateSource = 'followers';

// Fallback to similar accounts when followers are empty.
if (!profiles.length) {
  const raw = run('./scripts/flash-mcp.sh', ['similar', String(userId)]);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (parsed) {
    profiles = normalizeProfiles(parsed, userId)
      .filter((p) => p.username.toLowerCase() !== seedUsername)
      .slice(0, maxCount);
    if (profiles.length) candidateSource = 'similar_accounts_fallback';
  }
}

// Final fallback: keyword search by username seed.
if (!profiles.length) {
  const raw = run('./scripts/ig-mcp.sh', ['search-users', seedUsername, 'users']);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (parsed) {
    profiles = normalizeProfiles(parsed, userId)
      .filter((p) => p.username.toLowerCase() !== seedUsername)
      .slice(0, maxCount);
    if (profiles.length) candidateSource = 'search_users_fallback';
  }
}

function scoreCandidate(candidate, seed) {
  const reasons = [];
  let score = 0;
  const username = (candidate.username || '').toLowerCase();
  const seedLc = (seed || '').toLowerCase();

  if (seedLc && username.includes(seedLc)) {
    score += 40;
    reasons.push('username matches seed');
  }
  if (candidate.is_verified) {
    score += 15;
    reasons.push('verified');
  }
  const fc = Number(candidate.follower_count || 0);
  if (fc >= 1_000_000) {
    score += 20;
    reasons.push('1M+ followers');
  } else if (fc >= 100_000) {
    score += 12;
    reasons.push('100k+ followers');
  } else if (fc >= 10_000) {
    score += 7;
    reasons.push('10k+ followers');
  } else if (fc > 0) {
    score += 3;
    reasons.push('has followers data');
  }

  return { score, reasons };
}

const seedUsernameForScore = sourceUsername || String(inputRef).replace(/^@/, '').toLowerCase();
profiles = profiles
  .map((p) => {
    const s = scoreCandidate(p, seedUsernameForScore);
    return { ...p, score: s.score, score_reasons: s.reasons };
  })
  .sort((a, b) => (b.score || 0) - (a.score || 0) || a.username.localeCompare(b.username));

const generatedAt = new Date().toISOString();

const jsonPath = path.join(root, 'data', 'ig-candidates.json');
const mdPath = path.join(root, 'data', 'ig-candidates.md');

const doc = {
  input_ref: inputRef,
  source_user_id: String(userId),
  source_username: sourceUsername,
  generated_at: generatedAt,
  candidate_source: candidateSource,
  count: profiles.length,
  candidates: profiles.map((p, i) => ({
    key: `candidate_${i + 1}`,
    ...p,
    profile_url: `https://www.instagram.com/${p.username}/`,
    story_url: `https://www.instagram.com/stories/${p.username}/`
  }))
};

fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
fs.writeFileSync(jsonPath, JSON.stringify(doc, null, 2));

const lines = [
  '# IG Candidates',
  '',
  `- Input ref: ${doc.input_ref}`,
  `- Source user id: ${doc.source_user_id}`,
  `- Source username: ${doc.source_username || 'n/a'}`,
  `- Generated at: ${doc.generated_at}`,
  `- Candidate source: ${doc.candidate_source}`,
  `- Count: ${doc.count}`,
  '',
  '## Candidates',
  ''
];

for (const c of doc.candidates) {
  lines.push(`- ${c.key}: @${c.username} (${c.id || 'id-unknown'}) score=${c.score ?? 0}`);
}

if (!doc.candidates.length) {
  lines.push('- No candidates returned for this user id. Try another user id.');
}

fs.writeFileSync(mdPath, `${lines.join('\n')}\n`);

console.log(`Saved ${doc.count} candidates:`);
console.log(`- ${jsonPath}`);
console.log(`- ${mdPath}`);
