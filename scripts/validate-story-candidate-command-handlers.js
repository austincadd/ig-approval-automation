import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { registerStoryCandidateCommands } from '../bot/story-candidate-commands.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-story-command-handlers-'));
process.chdir(tempDir);

const handlers = [];
const sentMessages = [];
const bot = {
  onText(pattern, handler) {
    handlers.push({ pattern, handler });
  },
  async sendMessage(chatId, text) {
    sentMessages.push({ chatId, text });
  }
};

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE system_flags (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT
  );
  CREATE TABLE candidate_review_labels (
    candidate_key TEXT PRIMARY KEY,
    label TEXT,
    updated_at TEXT
  );
`);

const resources = registerStoryCandidateCommands({
  bot,
  db,
  chatId: 'test-chat',
  requireAuthorizedChat: () => true,
  enqueueCommandTask: async (task) => task(),
  runRepoCommand: async () => ({ stdout: '', stderr: '' })
});

function getHandler(command) {
  const literal = command.replace('/', '\\/');
  const entry = handlers.find(({ pattern }) => pattern.source.startsWith(literal));
  assert.ok(entry, `expected handler registration for ${command}`);
  return entry.handler;
}

const baseMsg = { chat: { id: 123 } };

const storiesHelp = getHandler('/stories_help');
await storiesHelp(baseMsg);
assert.equal(sentMessages.length, 1, 'stories_help should send one help message');
assert.equal(sentMessages[0].chatId, 'test-chat');
assert.match(sentMessages[0].text, /Story helper commands \(manual browsing only\):/);
assert.match(sentMessages[0].text, /\/stories_set @user1 @user2/);
assert.match(sentMessages[0].text, /\/stories_open IG_candidate_1/);

sentMessages.length = 0;

const storiesSet = getHandler('/stories_set');
await storiesSet(baseMsg, ['/stories_set @alice @bob', '@alice @bob']);
assert.equal(sentMessages.length, 1, 'stories_set should acknowledge saved targets');
assert.equal(sentMessages[0].text, 'Saved 2 story targets.');
assert.equal(
  fs.readFileSync(path.join(tempDir, 'data/story-targets.txt'), 'utf8'),
  '@alice\n@bob\n',
  'stories_set should persist normalized target list with trailing newline'
);
assert.deepEqual(
  JSON.parse(fs.readFileSync(path.join(tempDir, 'data/story-state.json'), 'utf8')),
  { index: 0 },
  'stories_set should reset story rotation state'
);

await resources.closeResources();
console.log('Story candidate command handler validation passed');
