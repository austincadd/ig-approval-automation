export const CHALLENGE_TEXT_MARKERS = [
  "confirm it's you",
  'unusual activity',
  'security code',
  'verify your identity',
  'help us confirm',
  'we suspect automated behavior',
  'your account has been temporarily locked',
  'temporarily locked',
  'enter the security code',
  'we noticed unusual activity',
  'confirm your identity',
  'checkpoint required'
];

export const CHALLENGE_URL_MARKERS = [
  '/challenge/',
  '/accounts/login',
  '/accounts/login/',
  '/checkpoint/',
  '/accounts/suspended/',
  '/consent/'
];

export const CHALLENGE_SELECTORS = [
  'form[action*="/accounts/login"]',
  'input[name="password"]',
  'input[name="verificationCode"]',
  'input[name="security_code"]',
  'input[autocomplete="one-time-code"]'
];

export function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function normalizeChallengeText(value = '') {
  return String(value)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function findChallengeUrlMarker(url = '') {
  const normalizedUrl = normalizeChallengeText(url);
  return CHALLENGE_URL_MARKERS.find((marker) => normalizedUrl.includes(marker)) || null;
}

export function findChallengeTextMarker(text = '') {
  const normalizedText = normalizeChallengeText(text);
  return CHALLENGE_TEXT_MARKERS.find((marker) => normalizedText.includes(marker)) || null;
}

export function detectChallengeFromSignals({ url = '', visibleText = '', selectorHits = [] } = {}) {
  const urlMarker = findChallengeUrlMarker(url);
  if (urlMarker) {
    return { blocked: true, reason: 'CHALLENGE_URL', detail: urlMarker };
  }

  if (selectorHits.length > 0) {
    return { blocked: true, reason: 'CHALLENGE_SELECTOR', detail: selectorHits[0] };
  }

  const textMarker = findChallengeTextMarker(visibleText);
  if (textMarker) {
    return { blocked: true, reason: 'CHALLENGE_TEXT', detail: textMarker };
  }

  return { blocked: false, reason: null, detail: null };
}
