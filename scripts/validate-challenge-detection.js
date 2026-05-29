import assert from 'node:assert/strict';
import { detectChallengeFromSignals, findChallengeTextMarker } from '../worker/safety.js';

assert.equal(findChallengeTextMarker('We need to confirm it\'s you before you continue.'), "confirm it's you");
assert.equal(findChallengeTextMarker('Your account has been temporarily locked.'), 'your account has been temporarily locked');
assert.equal(findChallengeTextMarker('This bootstrap payload contains challenge_required inside a script blob.'), null);

assert.deepEqual(
  detectChallengeFromSignals({
    url: 'https://www.instagram.com/challenge/',
    visibleText: '',
    selectorHits: []
  }),
  { blocked: true, reason: 'CHALLENGE_URL', detail: '/challenge/' }
);

assert.deepEqual(
  detectChallengeFromSignals({
    url: 'https://www.instagram.com/p/example/',
    visibleText: '',
    selectorHits: ['input[name="security_code"]']
  }),
  { blocked: true, reason: 'CHALLENGE_SELECTOR', detail: 'input[name="security_code"]' }
);

assert.deepEqual(
  detectChallengeFromSignals({
    url: 'https://www.instagram.com/p/example/',
    visibleText: 'Help us confirm that this account belongs to you. Enter the security code to continue.',
    selectorHits: []
  }),
  { blocked: true, reason: 'CHALLENGE_TEXT', detail: 'security code' }
);

assert.deepEqual(
  detectChallengeFromSignals({
    url: 'https://www.instagram.com/p/example/',
    visibleText: 'window.__initialData = { challenge_required: true }',
    selectorHits: []
  }),
  { blocked: false, reason: null, detail: null }
);

console.log('challenge detection validation passed');
