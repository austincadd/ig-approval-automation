import { waitForPrimaryActionControl } from './selectors.js';

function normalizeRow(row) {
  if (!row) return null;
  return {
    orientation: row.orientation,
    minX: row.minX,
    maxX: row.maxX,
    minY: row.minY,
    maxY: row.maxY,
    supportCount: row.supportCount,
    state: row.state,
    labels: [...(row.labels || [])]
  };
}

export function classifyVerificationOutcome(input = {}) {
  const signals = input.signals || {};
  const positiveSignals = [signals.stateFlipped, signals.domMutated, signals.controlRelocated, signals.countDelta].filter(Boolean).length;

  if (signals.stateFlipped) {
    return {
      ok: true,
      code: null,
      cause: 'confirmed_liked'
    };
  }

  if (signals.challengeBlocked) {
    return {
      ok: false,
      code: 'CHECKPOINT_DETECTED',
      cause: 'challenge_after_click'
    };
  }

  if (!signals.reResolvedControl) {
    return {
      ok: false,
      code: 'LIKE_VERIFICATION_ACTION_SURFACE_LOST',
      cause: 'action_surface_lost'
    };
  }

  if (signals.currentState === 'unliked' && positiveSignals === 0) {
    return {
      ok: false,
      code: 'LIKE_VERIFICATION_STATE_STILL_UNLIKED',
      cause: 'state_still_unliked'
    };
  }

  if (positiveSignals > 0) {
    return {
      ok: false,
      code: 'LIKE_VERIFICATION_AMBIGUOUS',
      cause: 'partial_signals_only'
    };
  }

  return {
    ok: false,
    code: 'LIKE_VERIFICATION_NO_SIGNAL',
    cause: 'no_confirmation_signal'
  };
}

export async function verifyLikeAction(page, {
  timeoutMs = 5000,
  preClickDescriptor = null,
  preClickState = 'unliked',
  preClickCountText = null,
  detectChallenge = null
} = {}) {
  const beforeSnapshot = await page.evaluate(() => document.body?.innerHTML || '').catch(() => '');
  const beforeLen = beforeSnapshot.length;

  const result = await waitForPrimaryActionControl(page, timeoutMs);
  const challenge = typeof detectChallenge === 'function' ? await detectChallenge(page) : { blocked: false, reason: null, detail: null };

  const afterCountText = await page.evaluate(() => {
    const numbers = Array.from(document.querySelectorAll('a, span, div'))
      .map((el) => (el.textContent || '').trim())
      .find((text) => /^\d[\d,.]*$/.test(text));
    return numbers || null;
  }).catch(() => null);

  const afterSnapshot = await page.evaluate(() => document.body?.innerHTML || '').catch(() => '');
  const descriptor = result.descriptor || null;
  const domMutated = beforeLen !== afterSnapshot.length;
  const controlRelocated = Boolean(descriptor && preClickDescriptor && (
    descriptor.aria !== preClickDescriptor.aria
    || descriptor.x !== preClickDescriptor.x
    || descriptor.y !== preClickDescriptor.y
  ));
  const countDelta = Boolean(preClickCountText && afterCountText && preClickCountText !== afterCountText);

  const signals = {
    previousState: preClickState,
    currentState: result.state,
    stateFlipped: preClickState !== 'liked' && result.ok && result.state === 'liked',
    reResolvedControl: result.ok,
    domMutated,
    controlRelocated,
    countDelta,
    challengeBlocked: challenge.blocked
  };

  const classification = classifyVerificationOutcome({ signals });

  return {
    ok: classification.ok,
    code: classification.code,
    cause: classification.cause,
    selector: descriptor ? `${descriptor.tag}[aria-label="${descriptor.aria}"] @ (${descriptor.x},${descriptor.y}) ${descriptor.w}x${descriptor.h}` : null,
    descriptor,
    row: normalizeRow(result.row),
    diagnostics: result.diagnostics,
    signals,
    challenge
  };
}
