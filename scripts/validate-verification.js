import assert from 'node:assert/strict';
import { classifyVerificationOutcome } from '../worker/verification.js';
import { classifyFailure } from '../core/failure-policy.js';

const confirmed = classifyVerificationOutcome({
  signals: {
    stateFlipped: true,
    domMutated: true,
    controlRelocated: true,
    countDelta: false,
    challengeBlocked: false,
    reResolvedControl: true,
    currentState: 'liked'
  }
});
assert.equal(confirmed.ok, true);

const lostSurface = classifyVerificationOutcome({
  signals: {
    stateFlipped: false,
    domMutated: true,
    controlRelocated: false,
    countDelta: false,
    challengeBlocked: false,
    reResolvedControl: false,
    currentState: 'unknown'
  }
});
assert.equal(lostSurface.code, 'LIKE_VERIFICATION_ACTION_SURFACE_LOST');
assert.equal(classifyFailure({ code: lostSurface.code }).policy, 'retry_now');

const stillUnliked = classifyVerificationOutcome({
  signals: {
    stateFlipped: false,
    domMutated: false,
    controlRelocated: false,
    countDelta: false,
    challengeBlocked: false,
    reResolvedControl: true,
    currentState: 'unliked'
  }
});
assert.equal(stillUnliked.code, 'LIKE_VERIFICATION_STATE_STILL_UNLIKED');

const ambiguous = classifyVerificationOutcome({
  signals: {
    stateFlipped: false,
    domMutated: true,
    controlRelocated: false,
    countDelta: false,
    challengeBlocked: false,
    reResolvedControl: true,
    currentState: 'unknown'
  }
});
assert.equal(ambiguous.code, 'LIKE_VERIFICATION_AMBIGUOUS');
assert.equal(classifyFailure({ code: ambiguous.code }).failureClass, 'state_verification_failure');

const noSignal = classifyVerificationOutcome({
  signals: {
    stateFlipped: false,
    domMutated: false,
    controlRelocated: false,
    countDelta: false,
    challengeBlocked: false,
    reResolvedControl: true,
    currentState: 'unknown'
  }
});
assert.equal(noSignal.code, 'LIKE_VERIFICATION_NO_SIGNAL');

const challenge = classifyVerificationOutcome({
  signals: {
    stateFlipped: false,
    domMutated: false,
    controlRelocated: false,
    countDelta: false,
    challengeBlocked: true,
    reResolvedControl: true,
    currentState: 'unknown'
  }
});
assert.equal(challenge.code, 'CHECKPOINT_DETECTED');

console.log('Verification validation passed');
