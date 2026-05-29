import assert from 'node:assert/strict';
import { classifyPageShapeFromSignals, PAGE_SHAPES } from '../worker/page-shape.js';
import { classifyFailure } from '../core/failure-policy.js';

const reel = classifyPageShapeFromSignals({
  url: 'https://www.instagram.com/reel/abc123/',
  visibleText: 'Reel caption',
  challengeSelectorHits: [],
  domSignals: { pathname: '/reel/abc123/', hasDialog: false, likeInDialog: false, hasCloseButton: false, likeInArticle: false, actionRail: true }
});
assert.equal(reel.shape, PAGE_SHAPES.REEL);

const modal = classifyPageShapeFromSignals({
  url: 'https://www.instagram.com/p/abc123/',
  visibleText: 'Post overlay',
  challengeSelectorHits: [],
  domSignals: { pathname: '/p/abc123/', hasDialog: true, likeInDialog: true, hasCloseButton: true, likeInArticle: false, actionRail: false }
});
assert.equal(modal.shape, PAGE_SHAPES.MODAL_OVERLAY_POST);

const feed = classifyPageShapeFromSignals({
  url: 'https://www.instagram.com/p/abc123/',
  visibleText: 'Normal post view',
  challengeSelectorHits: [],
  domSignals: { pathname: '/p/abc123/', hasDialog: false, likeInDialog: false, hasCloseButton: false, likeInArticle: true, actionRail: false }
});
assert.equal(feed.shape, PAGE_SHAPES.FEED_POST);

const unavailable = classifyPageShapeFromSignals({
  url: 'https://www.instagram.com/p/missing/',
  visibleText: "Sorry, this page isn't available.",
  challengeSelectorHits: [],
  domSignals: { pathname: '/p/missing/', hasDialog: false, likeInDialog: false, hasCloseButton: false, likeInArticle: false, actionRail: false }
});
assert.equal(unavailable.shape, PAGE_SHAPES.UNAVAILABLE);
assert.equal(classifyFailure({ code: 'TARGET_UNAVAILABLE' }).policy, 'suppress_candidate');

const challenge = classifyPageShapeFromSignals({
  url: 'https://www.instagram.com/accounts/login/',
  visibleText: 'Log in',
  challengeSelectorHits: ['input[name="password"]'],
  domSignals: { pathname: '/accounts/login/', hasDialog: false, likeInDialog: false, hasCloseButton: false, likeInArticle: false, actionRail: false }
});
assert.equal(challenge.shape, PAGE_SHAPES.CHALLENGE);
assert.equal(classifyFailure({ code: 'CHECKPOINT_DETECTED' }).policy, 'require_operator_action');

const unsupported = classifyPageShapeFromSignals({
  url: 'https://www.instagram.com/explore/',
  visibleText: 'Explore',
  challengeSelectorHits: [],
  domSignals: { pathname: '/explore/', hasDialog: false, likeInDialog: false, hasCloseButton: false, likeInArticle: false, actionRail: false }
});
assert.equal(unsupported.shape, PAGE_SHAPES.UNSUPPORTED);
assert.equal(classifyFailure({ code: 'TARGET_UNSUPPORTED_SHAPE' }).policy, 'pause_executor');

console.log('Page shape validation passed');
