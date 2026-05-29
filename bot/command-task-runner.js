import path from 'node:path';
import { runCommand } from '../core/command-runner.js';

export function createCommandTaskRunner({ repoCwd = path.resolve('.') } = {}) {
  let commandTaskQueue = Promise.resolve();

  function runRepoCommand(cmd, args, timeout = 90000) {
    return runCommand(cmd, args, { cwd: repoCwd, encoding: 'utf8', timeout });
  }

  function enqueueCommandTask(task) {
    if (typeof task !== 'function') {
      return Promise.reject(new TypeError('enqueueCommandTask requires a function task'));
    }

    const run = commandTaskQueue.then(
      () => Promise.resolve().then(task),
      () => Promise.resolve().then(task)
    );
    commandTaskQueue = run.catch(() => {});
    return run;
  }

  return {
    runRepoCommand,
    enqueueCommandTask
  };
}
