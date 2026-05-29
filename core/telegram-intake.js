const INSTAGRAM_POST_HOSTS = new Set(['instagram.com', 'www.instagram.com', 'm.instagram.com']);
const INSTAGRAM_POST_KINDS = new Set(['p', 'reel', 'tv']);

function normalizeHostname(hostname) {
  return String(hostname || '').trim().toLowerCase();
}

export function normalizeInstagramPostUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return null;

  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return null;
  }

  if (!INSTAGRAM_POST_HOSTS.has(normalizeHostname(parsed.hostname))) return null;

  const segments = parsed.pathname.split('/').filter(Boolean);
  const kind = String(segments[0] || '').toLowerCase();
  const code = String(segments[1] || '').trim();
  if (!INSTAGRAM_POST_KINDS.has(kind) || !code) return null;

  return `https://www.instagram.com/${kind}/${code}/`;
}

export function extractInstagramPostUrlsFromMessage(message) {
  const rawValues = [];
  const pushValue = (value) => {
    if (typeof value === 'string' && value.trim()) rawValues.push(value.trim());
  };

  pushValue(message?.text);
  pushValue(message?.caption);

  for (const entity of [...(message?.entities || []), ...(message?.caption_entities || [])]) {
    if (entity?.type === 'text_link') pushValue(entity.url);
  }

  const urlPattern = /https?:\/\/[^\s<>()]+/gi;
  const normalized = [];
  const seen = new Set();

  for (const raw of rawValues) {
    const matches = raw.match(urlPattern) || [];
    for (const match of matches) {
      const candidate = match.replace(/[),.!?]+$/g, '');
      const canonical = normalizeInstagramPostUrl(candidate);
      if (!canonical || seen.has(canonical)) continue;
      seen.add(canonical);
      normalized.push(canonical);
    }

    const directCanonical = normalizeInstagramPostUrl(raw);
    if (directCanonical && !seen.has(directCanonical)) {
      seen.add(directCanonical);
      normalized.push(directCanonical);
    }
  }

  return normalized;
}

export function ingestTelegramPostLinks(db, message, options = {}) {
  const actor = String(options.actor || 'telegram').trim() || 'telegram';
  const source = String(options.source || 'telegram').trim() || 'telegram';
  const urls = extractInstagramPostUrlsFromMessage(message);
  if (!urls.length) {
    return {
      status: 'ignored',
      reason: 'NO_INSTAGRAM_POST_URLS',
      items: []
    };
  }

  const insertCandidate = db.prepare(`INSERT OR IGNORE INTO candidates(post_url, source, note) VALUES (?, ?, ?)`);
  const readCandidate = db.prepare(`
    SELECT c.id, c.post_url, a.decision,
           EXISTS(
             SELECT 1
             FROM review_card_messages r
             WHERE r.candidate_id = c.id
               AND r.status = 'open'
           ) AS has_open_review_card
    FROM candidates c
    LEFT JOIN approvals a ON a.candidate_id = c.id
    WHERE c.post_url = ?
    LIMIT 1
  `);

  const noteParts = [
    `telegram_chat:${message?.chat?.id ?? 'unknown'}`,
    `telegram_message:${message?.message_id ?? 'unknown'}`,
    `actor:${actor}`
  ];
  const note = noteParts.join(' ');

  const items = [];
  for (const url of urls) {
    const insertInfo = insertCandidate.run(url, source, note);
    const row = readCandidate.get(url);
    if (!row?.id) continue;
    items.push({
      candidateId: row.id,
      postUrl: row.post_url,
      created: insertInfo.changes > 0,
      decision: row.decision || null,
      hasOpenReviewCard: Boolean(row.has_open_review_card)
    });
  }

  return {
    status: items.length ? 'ok' : 'ignored',
    reason: items.length ? null : 'NO_VALID_CANDIDATES',
    items
  };
}
