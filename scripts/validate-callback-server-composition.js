import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const sourcePath = path.resolve('bot/telegram-callback-server.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const marker = 'const db = new Database(path.resolve(\'data/ig_automation.db\'));';
const markerIndex = source.indexOf(marker);
assert.ok(markerIndex > 0, 'expected callback server bootstrap marker in source file');

const compositionModuleSource = `${source.slice(0, markerIndex)}\nmodule.exports = { registerCallbackServerComposition };`;

const calls = [];
const stubState = {
  callbackRoutingArgs: null,
  telegramMessageIntakeArgs: null,
  storyCandidateArgs: null,
  operatorTelegramArgs: null,
  operatorHttpArgs: null
};

function makeStub(name, callback) {
  return (...args) => {
    calls.push(name);
    return callback?.(...args);
  };
}

const registerCallbackHandlers = makeStub('registerCallbackHandlers', (args) => {
  stubState.callbackRoutingArgs = args;
});
const registerTelegramMessageIntake = makeStub('registerTelegramMessageIntake', (args) => {
  stubState.telegramMessageIntakeArgs = args;
});
const registerStoryCandidateCommands = makeStub('registerStoryCandidateCommands', (args) => {
  stubState.storyCandidateArgs = args;
  return { closeResources: async () => 'closed' };
});
const registerOperatorTelegramCommands = makeStub('registerOperatorTelegramCommands', (args) => {
  stubState.operatorTelegramArgs = args;
});
const registerOperatorHttpRoutes = makeStub('registerOperatorHttpRoutes', (args) => {
  stubState.operatorHttpArgs = args;
});

const transformedSource = compositionModuleSource
  .replace("import 'dotenv/config';\n", '')
  .replace(/import dns from 'node:dns';\n/, 'const dns = { setDefaultResultOrder() {} };\n')
  .replace(/import express from 'express';\n/, 'const express = {};\n')
  .replace(/import path from 'node:path';\n/, 'const path = {};\n')
  .replace(/import Database from 'better-sqlite3';\n/, 'const Database = function Database() {};\n')
  .replace(/import TelegramBot from 'node-telegram-bot-api';\n/, 'const TelegramBot = function TelegramBot() {};\n')
  .replace(/import \{ acquireSingleInstanceLock \} from '\.\/single-instance\.js';\n/, 'const acquireSingleInstanceLock = () => ({});\n')
  .replace(/import \{ registerCallbackHandlers \} from '\.\/callback-routing\.js';\n/, 'const registerCallbackHandlers = globalThis.__stubs.registerCallbackHandlers;\n')
  .replace(/import \{ createReviewCardService \} from '\.\/review-card-service\.js';\n/, 'const createReviewCardService = () => ({});\n')
  .replace(/import \{ registerStoryCandidateCommands \} from '\.\/story-candidate-commands\.js';\n/, 'const registerStoryCandidateCommands = globalThis.__stubs.registerStoryCandidateCommands;\n')
  .replace(/import \{ registerOperatorTelegramCommands \} from '\.\/operator-telegram-commands\.js';\n/, 'const registerOperatorTelegramCommands = globalThis.__stubs.registerOperatorTelegramCommands;\n')
  .replace(/import \{ registerOperatorHttpRoutes \} from '\.\/operator-http-routes\.js';\n/, 'const registerOperatorHttpRoutes = globalThis.__stubs.registerOperatorHttpRoutes;\n')
  .replace(/import \{ registerTelegramMessageIntake \} from '\.\/telegram-message-intake\.js';\n/, 'const registerTelegramMessageIntake = globalThis.__stubs.registerTelegramMessageIntake;\n')
  .replace(/import \{ createCommandTaskRunner \} from '\.\/command-task-runner\.js';\n/, 'const createCommandTaskRunner = () => ({ runRepoCommand: async () => ({}), enqueueCommandTask: async (task) => task() });\n')
  .replace(/import \{ createControlPlaneAuth \} from '\.\/control-plane-auth\.js';\n/, 'const createControlPlaneAuth = () => ({ requireAuthorizedChat: () => true, isAuthorizedActor: () => true, isAuthorizedControlRequest: () => true, rejectUnauthorizedControlRequest: () => undefined });\n')
  .replace(/import \{ createTelegramResultReporter \} from '\.\/telegram-result-reporter\.js';\n/, 'const createTelegramResultReporter = () => ({ start() {}, stop() {} });\n')
  .replace(/import \{ classifyTelegramError, createTelegramTransportHealthStore \} from '\.\/telegram-transport-health\.js';\n/, 'const classifyTelegramError = () => ({ duplicate: false, transient: false });\nconst createTelegramTransportHealthStore = () => ({ writeTransportHealth() {}, readTransportHealth() { return {}; } });\n')
  .replace('export function registerCallbackServerComposition', 'function registerCallbackServerComposition');

const context = vm.createContext({
  module: { exports: {} },
  exports: {},
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  globalThis: {
    __stubs: {
      registerCallbackHandlers,
      registerTelegramMessageIntake,
      registerStoryCandidateCommands,
      registerOperatorTelegramCommands,
      registerOperatorHttpRoutes
    }
  }
});
vm.runInContext(transformedSource, context, { filename: sourcePath });

const { registerCallbackServerComposition } = context.module.exports;
assert.equal(typeof registerCallbackServerComposition, 'function', 'expected registerCallbackServerComposition export');

const app = { id: 'app' };
const bot = { id: 'bot' };
const db = { id: 'db' };
const chatId = 'chat-123';
const controlGuards = {
  isAuthorizedActor: () => true,
  isAuthorizedControlRequest: () => true,
  rejectUnauthorizedControlRequest: () => undefined
};
const reviewCardService = {
  getCandidateForReview: () => ({ id: 1 }),
  handleAction: async () => undefined,
  isValidCallbackAction: () => true,
  sendReviewBatch: async () => ({ sent: 0 }),
  sendReviewCard: async () => undefined
};
const commandHelpers = {
  requireAuthorizedChat: () => true,
  enqueueCommandTask: async (task) => task(),
  runRepoCommand: async () => ({ stdout: '', stderr: '' })
};
let resultReporterStarts = 0;
const result = registerCallbackServerComposition({
  app,
  bot,
  db,
  chatId,
  controlGuards,
  reviewCardService,
  commandHelpers,
  startResultReporter: () => {
    calls.push('startResultReporter');
    resultReporterStarts += 1;
  }
});

assert.deepEqual(
  calls,
  [
    'registerCallbackHandlers',
    'startResultReporter',
    'registerTelegramMessageIntake',
    'registerStoryCandidateCommands',
    'registerOperatorTelegramCommands',
    'registerOperatorHttpRoutes'
  ],
  'expected callback-server composition to register seams in stable order'
);
assert.equal(resultReporterStarts, 1, 'expected result reporter startup exactly once');
assert.equal(typeof result?.closeResources, 'function', 'expected composition helper to expose closeResources()');

assert.equal(stubState.callbackRoutingArgs.app, app, 'callback routing should receive app');
assert.equal(stubState.callbackRoutingArgs.bot, bot, 'callback routing should receive bot');
assert.equal(stubState.callbackRoutingArgs.isAuthorizedActor, controlGuards.isAuthorizedActor, 'callback routing should receive actor guard');
assert.equal(stubState.callbackRoutingArgs.isAuthorizedControlRequest, controlGuards.isAuthorizedControlRequest, 'callback routing should receive control-request guard');
assert.equal(stubState.callbackRoutingArgs.rejectUnauthorizedControlRequest, controlGuards.rejectUnauthorizedControlRequest, 'callback routing should receive rejection helper');
assert.equal(stubState.callbackRoutingArgs.isValidCallbackAction, reviewCardService.isValidCallbackAction, 'callback routing should receive callback validator');
assert.equal(stubState.callbackRoutingArgs.handleAction, reviewCardService.handleAction, 'callback routing should receive callback action handler');

assert.equal(stubState.telegramMessageIntakeArgs.bot, bot, 'message intake should receive bot');
assert.equal(stubState.telegramMessageIntakeArgs.db, db, 'message intake should receive db');
assert.equal(stubState.telegramMessageIntakeArgs.chatId, chatId, 'message intake should receive chatId');
assert.equal(stubState.telegramMessageIntakeArgs.isAuthorizedActor, controlGuards.isAuthorizedActor, 'message intake should receive actor guard');
assert.equal(stubState.telegramMessageIntakeArgs.getCandidateForReview, reviewCardService.getCandidateForReview, 'message intake should receive review lookup');
assert.equal(stubState.telegramMessageIntakeArgs.sendReviewCard, reviewCardService.sendReviewCard, 'message intake should receive review card sender');

assert.equal(stubState.storyCandidateArgs.bot, bot, 'story commands should receive bot');
assert.equal(stubState.storyCandidateArgs.db, db, 'story commands should receive db');
assert.equal(stubState.storyCandidateArgs.chatId, chatId, 'story commands should receive chatId');
assert.equal(stubState.storyCandidateArgs.requireAuthorizedChat, commandHelpers.requireAuthorizedChat, 'story commands should receive chat guard');
assert.equal(stubState.storyCandidateArgs.enqueueCommandTask, commandHelpers.enqueueCommandTask, 'story commands should receive task queue');
assert.equal(stubState.storyCandidateArgs.runRepoCommand, commandHelpers.runRepoCommand, 'story commands should receive repo command runner');

assert.equal(stubState.operatorTelegramArgs.bot, bot, 'operator Telegram commands should receive bot');
assert.equal(stubState.operatorTelegramArgs.db, db, 'operator Telegram commands should receive db');
assert.equal(stubState.operatorTelegramArgs.chatId, chatId, 'operator Telegram commands should receive chatId');
assert.equal(stubState.operatorTelegramArgs.requireAuthorizedChat, commandHelpers.requireAuthorizedChat, 'operator Telegram commands should receive chat guard');

assert.equal(stubState.operatorHttpArgs.app, app, 'operator HTTP routes should receive app');
assert.equal(stubState.operatorHttpArgs.db, db, 'operator HTTP routes should receive db');
assert.equal(stubState.operatorHttpArgs.isAuthorizedControlRequest, controlGuards.isAuthorizedControlRequest, 'operator HTTP routes should receive control auth guard');
assert.equal(stubState.operatorHttpArgs.rejectUnauthorizedControlRequest, controlGuards.rejectUnauthorizedControlRequest, 'operator HTTP routes should receive rejection helper');
assert.equal(stubState.operatorHttpArgs.sendReviewBatch, reviewCardService.sendReviewBatch, 'operator HTTP routes should receive batch sender');

console.log('Callback server composition validation passed');
