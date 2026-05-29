import assert from 'node:assert/strict';
import {
  inspectPrimaryActionRow,
  pickPreferredControl,
  waitForPrimaryActionControlWithRetry
} from '../worker/selectors.js';

const labels = ['Like'];
const likedLabels = ['Unlike', 'Liked'];

const domOrderFixture = [
  { index: 23, tag: 'DIV', aria: 'Like', x: 1074, y: 1595, w: 16, h: 16, visible: true },
  { index: 24, tag: 'svg', aria: 'Like', x: 1074, y: 1595, w: 16, h: 16, visible: true },
  { index: 74, tag: 'DIV', aria: 'Like', x: 779, y: 501, w: 40, h: 40, visible: true },
  { index: 76, tag: 'DIV', aria: 'Comment', x: 848, y: 501, w: 40, h: 40, visible: true },
  { index: 77, tag: 'DIV', aria: 'Share', x: 948, y: 501, w: 40, h: 40, visible: true },
  { index: 78, tag: 'DIV', aria: 'Save', x: 1068, y: 509, w: 24, h: 24, visible: true }
];

const pickedPrimary = pickPreferredControl(domOrderFixture, labels);
assert.equal(pickedPrimary?.index, 74, 'should prefer the large visible primary like control over earlier comment-like DOM matches');

const primaryInspection = inspectPrimaryActionRow(domOrderFixture);
assert.equal(primaryInspection.ok, true, 'should detect the primary action row when support actions are present');
assert.equal(primaryInspection.state, 'unliked', 'should classify the primary row as unliked when the top-level control is Like');
assert.equal(primaryInspection.primaryControl?.index, 74, 'should select the main post like control from the primary action row');
assert.equal(primaryInspection.layoutFamily, 'feed_row', 'should classify a standard horizontal action row as the feed-row layout family');

const likedFixture = [
  { index: 23, tag: 'DIV', aria: 'Like', x: 1074, y: 1595, w: 16, h: 16, visible: true },
  { index: 74, tag: 'DIV', aria: 'Unlike', x: 778, y: 500, w: 42, h: 42, visible: true },
  { index: 75, tag: 'svg', aria: 'Unlike', x: 786, y: 508, w: 25, h: 25, visible: true },
  { index: 76, tag: 'DIV', aria: 'Comment', x: 846, y: 500, w: 40, h: 40, visible: true },
  { index: 77, tag: 'DIV', aria: 'Share', x: 946, y: 500, w: 40, h: 40, visible: true },
  { index: 78, tag: 'DIV', aria: 'Save', x: 1066, y: 508, w: 24, h: 24, visible: true }
];

const pickedLiked = pickPreferredControl(likedFixture, likedLabels);
assert.equal(pickedLiked?.index, 74, 'should confirm the primary liked-state control');

const likedInspection = inspectPrimaryActionRow(likedFixture);
assert.equal(likedInspection.ok, true, 'should still detect the primary action row when the main control is already liked');
assert.equal(likedInspection.state, 'liked', 'should classify Unlike/Liked primary controls as already liked');
assert.equal(likedInspection.primaryControl?.index, 74, 'should prefer the already-liked primary control over comment-level likes');

const commentLikeOnly = [
  { index: 1, tag: 'DIV', aria: 'Like', x: 945, y: 258, w: 16, h: 16, visible: true },
  { index: 2, tag: 'DIV', aria: 'Like', x: 945, y: 387, w: 16, h: 16, visible: true },
  { index: 3, tag: 'DIV', aria: 'Like', x: 945, y: 516, w: 16, h: 16, visible: true }
];

const commentInspection = inspectPrimaryActionRow(commentLikeOnly);
assert.equal(commentInspection.ok, false, 'should refuse to treat isolated comment-level likes as the primary action row');
assert.ok(Array.isArray(commentInspection.diagnostics.rows), 'should expose row diagnostics when no primary action row is found');
assert.ok(Array.isArray(commentInspection.diagnostics.columns), 'should expose column diagnostics when no primary action row is found');
assert.ok(commentInspection.diagnostics.fallbackCandidates.length > 0, 'should retain scored fallback candidates for diagnostics even when no cluster qualifies');
assert.ok(commentInspection.diagnostics.fallbackCandidates.every((candidate, index, list) => index === 0 || list[index - 1].score >= candidate.score), 'should sort fallback candidates by descending score for diagnosability');

const reelRailFixture = [
  { index: 5, tag: 'DIV', aria: 'Like', x: 864, y: 326, w: 24, h: 24, visible: true },
  { index: 7, tag: 'DIV', aria: 'Comment', x: 856, y: 382, w: 40, h: 52, visible: true },
  { index: 8, tag: 'DIV', aria: 'Repost', x: 864, y: 454, w: 24, h: 24, visible: true },
  { index: 10, tag: 'DIV', aria: 'Share', x: 864, y: 518, w: 24, h: 24, visible: true },
  { index: 11, tag: 'DIV', aria: 'Save', x: 864, y: 570, w: 24, h: 24, visible: true }
];

const reelInspection = inspectPrimaryActionRow(reelRailFixture);
assert.equal(reelInspection.ok, true, 'should detect the vertical reel action rail as a valid primary action surface');
assert.equal(reelInspection.state, 'unliked', 'should classify the reel rail like control as unliked');
assert.equal(reelInspection.row?.orientation, 'column', 'should record that the detected surface is a vertical action column');
assert.equal(reelInspection.primaryControl?.index, 5, 'should select the reel rail like control as the primary control');
assert.equal(reelInspection.layoutFamily, 'reel_rail', 'should classify the reel action column as the reel-rail layout family');

const modalCompactFixture = [
  { index: 41, tag: 'DIV', aria: 'Like', x: 402, y: 712, w: 32, h: 32, visible: true },
  { index: 42, tag: 'DIV', aria: 'Comment', x: 452, y: 712, w: 32, h: 32, visible: true },
  { index: 43, tag: 'DIV', aria: 'Share', x: 502, y: 712, w: 32, h: 32, visible: true },
  { index: 44, tag: 'DIV', aria: 'Save', x: 552, y: 712, w: 24, h: 24, visible: true }
];

const modalInspection = inspectPrimaryActionRow(modalCompactFixture);
assert.equal(modalInspection.ok, true, 'should still recognize a compact modal action row');
assert.equal(modalInspection.layoutFamily, 'modal_compact', 'should classify narrower rows as the modal-compact layout family');
assert.equal(modalInspection.diagnostics.fallbackCandidates[0]?.variant, 'modal_compact', 'should carry layout metadata into fallback diagnostics');

const smallOnlyFixture = [
  { index: 1, tag: 'DIV', aria: 'Like', x: 10, y: 20, w: 16, h: 16, visible: true },
  { index: 2, tag: 'DIV', aria: 'Like', x: 10, y: 60, w: 16, h: 16, visible: true }
];

const fallback = pickPreferredControl(smallOnlyFixture, labels);
assert.equal(fallback?.index, 1, 'should gracefully fall back when only small controls exist');

function createMockPage(frames) {
  let frameIndex = 0;
  const waits = [];
  const wheelCalls = [];
  const page = {
    mouse: {
      async wheel(x, y) {
        wheelCalls.push([x, y]);
      }
    },
    async waitForTimeout(ms) {
      waits.push(ms);
      await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 2)));
    },
    locator() {
      return {
        async evaluateAll(mapper) {
          const frame = frames[Math.min(frameIndex, frames.length - 1)] || [];
          const previousWindow = globalThis.window;
          globalThis.window = {
            getComputedStyle() {
              return {
                display: 'block',
                visibility: 'visible'
              };
            }
          };

          try {
            const result = mapper(frame.map((candidate) => ({
              matches(selector) {
                return selector === '[aria-label]';
              },
              querySelector() {
                return null;
              },
              getAttribute(name) {
                return name === 'aria-label' ? candidate.aria : null;
              },
              getBoundingClientRect() {
                return {
                  x: candidate.x,
                  y: candidate.y,
                  width: candidate.w,
                  height: candidate.h
                };
              },
              get tagName() {
                return candidate.tag;
              }
            })));
            frameIndex += 1;
            return result;
          } finally {
            globalThis.window = previousWindow;
          }
        }
      };
    },
    async evaluateHandle(_fn, payload) {
      const current = frames[Math.max(0, frameIndex - 1)] || [];
      const match = current.find((candidate) => {
        const centerX = candidate.x + (candidate.w / 2);
        const centerY = candidate.y + (candidate.h / 2);
        return Math.abs(centerX - payload.center.x) <= 1 && Math.abs(centerY - payload.center.y) <= 1;
      });

      const handle = {
        descriptor: match,
        asElement() {
          return match ? { descriptor: match } : null;
        },
        async dispose() {}
      };

      return handle;
    }
  };

  return { page, waits, wheelCalls };
}

const retryMissMock = createMockPage([
  commentLikeOnly,
  commentLikeOnly
]);
const retryMiss = await waitForPrimaryActionControlWithRetry(retryMissMock.page, { timeoutMs: 1, settleWaitMs: 25 });
assert.equal(retryMiss.ok, false, 'should remain unresolved when retry still does not expose a primary action surface');
assert.equal(retryMiss.attempts, 2, 'should report that the retry path was exercised');
assert.ok(Array.isArray(retryMiss.firstAttemptDiagnostics?.rows), 'should preserve first-attempt row diagnostics across the retry path');
assert.equal(retryMiss.firstAttemptCandidates.length, commentLikeOnly.length, 'should preserve first-attempt candidates for downstream diagnostics');
assert.deepEqual(retryMissMock.wheelCalls, [[0, 64], [0, -64]], 'should perform the bounded reel-settle scroll nudge before retrying');

const retryRecoverMock = createMockPage([
  commentLikeOnly,
  reelRailFixture
]);
const retryRecover = await waitForPrimaryActionControlWithRetry(retryRecoverMock.page, { timeoutMs: 1, settleWaitMs: 25 });
assert.equal(retryRecover.ok, true, 'should recover when the reel action rail appears on the retry scan');
assert.equal(retryRecover.attempts, 2, 'should record a two-attempt recovery');
assert.equal(retryRecover.state, 'unliked', 'should carry forward the recovered control state');
assert.equal(retryRecover.descriptor?.aria, 'Like', 'should return the recovered reel primary control');
assert.equal(retryRecover.descriptor?.x, 864, 'should preserve the recovered reel control geometry');
assert.ok(Array.isArray(retryRecover.firstAttemptDiagnostics?.columns), 'should still attach the first-attempt diagnostics when recovery succeeds on retry');

console.log('Like control selection validation passed');
