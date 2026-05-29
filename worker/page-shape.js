import { detectChallengeFromSignals, CHALLENGE_SELECTORS } from './safety.js';

export const PAGE_SHAPES = Object.freeze({
  REEL: 'reel',
  FEED_POST: 'feed_post',
  MODAL_OVERLAY_POST: 'modal_overlay_post',
  UNAVAILABLE: 'unavailable',
  CHALLENGE: 'challenge_login',
  UNSUPPORTED: 'unsupported_shape'
});

const UNAVAILABLE_TEXT_MARKERS = [
  "sorry, this page isn't available",
  'page not found',
  'content unavailable',
  'post unavailable',
  'this content is no longer available',
  'link you followed may be broken'
];

function normalize(value = '') {
  return String(value).toLowerCase().replace(/\s+/g, ' ').trim();
}

function hasMarker(text, markers) {
  const normalized = normalize(text);
  return markers.find((marker) => normalized.includes(marker)) || null;
}

async function getChallengeSelectorHits(page) {
  const hits = [];
  for (const selector of CHALLENGE_SELECTORS) {
    const count = await page.locator(selector).count().catch(() => 0);
    if (count > 0) hits.push(selector);
  }
  return hits;
}

export async function collectPageShapeSignals(page) {
  const url = page.url();
  const [visibleText, challengeSelectorHits, domSignals] = await Promise.all([
    page.evaluate(() => document.body?.innerText || '').catch(() => ''),
    getChallengeSelectorHits(page),
    page.evaluate(() => {
      const pathname = window.location.pathname || '';
      const dialog = document.querySelector('[role="dialog"]');
      const article = document.querySelector('article');
      const main = document.querySelector('main');
      const likeInDialog = dialog?.querySelector('[aria-label="Like"], [aria-label="Unlike"], [aria-label="Liked"]');
      const likeInArticle = article?.querySelector('[aria-label="Like"], [aria-label="Unlike"], [aria-label="Liked"]');
      const closeButton = dialog?.querySelector('[aria-label="Close"], svg[aria-label="Close"], button[aria-label="Close"]');
      const actionRail = Array.from(document.querySelectorAll('[aria-label]')).some((el) => {
        const label = el.getAttribute('aria-label');
        if (!['Like', 'Unlike', 'Liked', 'Comment', 'Repost', 'Share', 'Save'].includes(label)) return false;
        const rect = el.getBoundingClientRect();
        return rect.x > (window.innerWidth * 0.66);
      });

      return {
        pathname,
        hasDialog: Boolean(dialog),
        hasArticle: Boolean(article),
        hasMain: Boolean(main),
        hasCloseButton: Boolean(closeButton),
        likeInDialog: Boolean(likeInDialog),
        likeInArticle: Boolean(likeInArticle),
        actionRail
      };
    }).catch(() => ({ pathname: '', hasDialog: false, hasArticle: false, hasMain: false, hasCloseButton: false, likeInDialog: false, likeInArticle: false, actionRail: false }))
  ]);

  return { url, visibleText, challengeSelectorHits, domSignals };
}

export function classifyPageShapeFromSignals(signals = {}) {
  const challenge = detectChallengeFromSignals({
    url: signals.url,
    visibleText: signals.visibleText,
    selectorHits: signals.challengeSelectorHits || []
  });
  if (challenge.blocked) {
    return { shape: PAGE_SHAPES.CHALLENGE, reason: challenge.reason, detail: challenge.detail, challenge };
  }

  const unavailableMarker = hasMarker(signals.visibleText, UNAVAILABLE_TEXT_MARKERS);
  if (unavailableMarker) {
    return { shape: PAGE_SHAPES.UNAVAILABLE, reason: 'UNAVAILABLE_TEXT', detail: unavailableMarker };
  }

  const pathname = signals.domSignals?.pathname || new URL(signals.url || 'https://www.instagram.com/').pathname;
  if (pathname.includes('/reel/')) {
    return { shape: PAGE_SHAPES.REEL, reason: 'URL_REEL', detail: pathname };
  }

  if (signals.domSignals?.hasDialog && (signals.domSignals?.likeInDialog || signals.domSignals?.hasCloseButton)) {
    return { shape: PAGE_SHAPES.MODAL_OVERLAY_POST, reason: 'DIALOG_POST', detail: pathname };
  }

  if (pathname.includes('/p/') || pathname.includes('/tv/') || signals.domSignals?.likeInArticle) {
    return { shape: PAGE_SHAPES.FEED_POST, reason: 'ARTICLE_POST', detail: pathname };
  }

  if (signals.domSignals?.actionRail) {
    return { shape: PAGE_SHAPES.REEL, reason: 'ACTION_RAIL', detail: pathname };
  }

  return { shape: PAGE_SHAPES.UNSUPPORTED, reason: 'NO_SUPPORTED_LAYOUT', detail: pathname };
}

export async function classifyPageShape(page) {
  const signals = await collectPageShapeSignals(page);
  const classification = classifyPageShapeFromSignals(signals);
  return { ...classification, signals };
}
