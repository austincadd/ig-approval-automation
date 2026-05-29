import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startValidationServer(mode) {
  const commandRunnerUrl = pathToFileURL(path.resolve('core/command-runner.js')).href;
  const routeName = mode === 'sync' ? '/simulate/candidates_build_sync' : '/simulate/candidates_build_async';
  const routeBody = mode === 'sync'
    ? `
      const { execFileSync } = await import('node:child_process');
      app.get('${routeName}', (_req, res) => {
        const stdout = execFileSync(
          'node',
          ['-e', "setTimeout(() => { process.stdout.write('sync-done'); }, 700)"],
          { cwd: process.cwd(), encoding: 'utf8', timeout: 5000 }
        );
        res.json({ ok: true, stdout: stdout.trim() });
      });
    `
    : `
      const { runCommand } = await import('${commandRunnerUrl}');
      app.get('${routeName}', async (_req, res) => {
        const result = await runCommand(
          'node',
          ['-e', "setTimeout(() => { process.stdout.write('async-done'); }, 700)"],
          { cwd: process.cwd(), encoding: 'utf8', timeout: 5000 }
        );
        res.json({ ok: true, stdout: result.stdout.trim() });
      });
    `;

  const childSource = `
    const express = (await import('express')).default;
    const app = express();
    app.get('/debug/queue', (_req, res) => {
      res.json({ ok: true, ts: Date.now() });
    });
    ${routeBody}
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      console.log('LISTENING ' + address.port);
    });
    process.on('SIGTERM', () => server.close(() => process.exit(0)));
    process.on('SIGINT', () => server.close(() => process.exit(0)));
  `;

  const child = spawn('node', ['--input-type=module', '-e', childSource], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Validation server did not start for ${mode}. stderr=${stderr}`)), 5000);
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      const match = text.match(/LISTENING (\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(Number(match[1]));
      }
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`Validation server exited early for ${mode} (code=${code}, signal=${signal}). stderr=${stderr}`));
    });
  });

  return {
    child,
    baseUrl: `http://127.0.0.1:${port}`,
    routeName,
    async stop() {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
  };
}

async function reproduceSyncHang() {
  const server = await startValidationServer('sync');

  try {
    const slowPromise = fetch(`${server.baseUrl}${server.routeName}`).then(async (res) => {
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch (error) {
        throw new Error(`sync route returned non-JSON (status=${res.status}): ${text.slice(0, 200)}`);
      }
      return { status: res.status, json };
    });

    await sleep(100);

    const queueStartedAt = Date.now();
    let queueTimedOut = false;
    let queueElapsedMs = 0;
    try {
      await fetch(`${server.baseUrl}/debug/queue`, { signal: AbortSignal.timeout(250) });
      queueElapsedMs = Date.now() - queueStartedAt;
    } catch (error) {
      queueElapsedMs = Date.now() - queueStartedAt;
      if (error?.name === 'TimeoutError') {
        queueTimedOut = true;
      } else {
        throw error;
      }
    }

    assert.equal(queueTimedOut, true, `expected /debug/queue to hang behind sync child process, got response in ${queueElapsedMs}ms`);

    const slowResponse = await slowPromise;
    assert.equal(slowResponse.status, 200, 'sync route should still eventually complete');
    assert.deepEqual(slowResponse.json, { ok: true, stdout: 'sync-done' }, 'sync route should complete with expected payload');

    return { queueElapsedMs };
  } finally {
    await server.stop();
  }
}

async function validateAsyncFix() {
  const server = await startValidationServer('async');

  try {
    const slowPromise = fetch(`${server.baseUrl}${server.routeName}`).then(async (res) => {
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch (error) {
        throw new Error(`async route returned non-JSON (status=${res.status}): ${text.slice(0, 200)}`);
      }
    });
    await sleep(100);

    const queueStartedAt = Date.now();
    const queueResponse = await fetch(`${server.baseUrl}/debug/queue`);
    const queueElapsedMs = Date.now() - queueStartedAt;
    const queueJson = await queueResponse.json();

    assert.equal(queueResponse.status, 200, 'debug queue endpoint should respond during async child process');
    assert.equal(queueJson.ok, true, 'debug queue endpoint should return ok=true');
    assert.ok(queueElapsedMs < 300, `debug queue endpoint should stay responsive during async child process (got ${queueElapsedMs}ms)`);

    const slowJson = await slowPromise;
    assert.deepEqual(slowJson, { ok: true, stdout: 'async-done' }, 'async route should still complete successfully');

    return { queueElapsedMs };
  } finally {
    await server.stop();
  }
}

const syncRepro = await reproduceSyncHang();
const asyncValidation = await validateAsyncFix();

console.log(
  `Callback responsiveness validation passed (sync hang reproduced with /debug/queue timeout after ${syncRepro.queueElapsedMs}ms; async /debug/queue=${asyncValidation.queueElapsedMs}ms)`
);
