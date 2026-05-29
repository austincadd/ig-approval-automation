import assert from 'node:assert/strict';
import { registerStoryCandidateCommands } from '../bot/story-candidate-commands.js';

const registrations = [];
const bot = {
  onText(pattern, handler) {
    registrations.push({ pattern, handler });
  }
};

const db = {
  prepare() {
    return {
      get() {
        return undefined;
      },
      all() {
        return [];
      },
      run() {
        return undefined;
      }
    };
  }
};

const resourceHandle = registerStoryCandidateCommands({
  bot,
  db,
  chatId: 'test-chat',
  requireAuthorizedChat: () => true,
  enqueueCommandTask: async (task) => task(),
  runRepoCommand: async () => ({ stdout: '', stderr: '' })
});

assert.equal(typeof resourceHandle?.closeResources, 'function', 'registerStoryCandidateCommands should expose closeResources()');

const expectedCommands = [
  '/stories_help',
  '/stories_set',
  '/candidates_from_comments',
  '/candidates_fuse',
  '/candidates_build',
  '/pipeline_health',
  '/candidates_source',
  '/candidates_top',
  '/candidates_next',
  '/candidates_skip',
  '/candidates_mark_good',
  '/candidates_mark_bad',
  '/stories_list',
  '/stories_start',
  '/stories_next',
  '/stories_open'
];

assert.equal(registrations.length, expectedCommands.length, 'expected one registration per story/candidate command');

const registeredSources = registrations.map(({ pattern }) => {
  assert.ok(pattern instanceof RegExp, 'bot.onText should receive RegExp patterns');
  return pattern.source;
});

for (const command of expectedCommands) {
  const literal = command.replace('/', '\\/');
  assert.ok(
    registeredSources.some((source) => source.startsWith(literal)),
    `expected command registration for ${command}`
  );
}

const uniqueSources = new Set(registeredSources);
assert.equal(uniqueSources.size, registeredSources.length, 'expected command patterns to be unique');
assert.ok(
  registeredSources.some((source) => source.includes('stories_open') && source.includes('(.+)')),
  'stories_open registration should capture a target argument'
);
assert.ok(
  registeredSources.some((source) => source.includes('stories_set') && source.includes('(.+)')),
  'stories_set registration should capture target list arguments'
);
assert.ok(
  registeredSources.some((source) => source.includes('candidates_top') && source.includes('(.+)')),
  'candidates_top registration should accept optional filter arguments'
);

for (const { handler, pattern } of registrations) {
  assert.equal(typeof handler, 'function', `registration for ${pattern} should provide a handler function`);
}

console.log(`Story candidate command registration validation passed (${registrations.length} commands)`);
