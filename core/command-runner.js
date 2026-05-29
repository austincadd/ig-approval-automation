import { execFile } from 'node:child_process';

/**
 * @typedef {Object} RunCommandOptions
 * @property {string=} cwd
 * @property {BufferEncoding=} encoding
 * @property {number=} timeout
 * @property {number=} maxBuffer
 */

/**
 * Run a child command without blocking the Node.js event loop.
 * Resolves with stdout/stderr, or rejects with the original execFile error
 * decorated with captured stdout/stderr for callers that already inspect them.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {RunCommandOptions=} options
 * @returns {Promise<{stdout:string, stderr:string}>}
 */
export function runCommand(cmd, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        cwd: options.cwd,
        encoding: options.encoding || 'utf8',
        timeout: options.timeout,
        maxBuffer: options.maxBuffer || 10 * 1024 * 1024
      },
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });
}
