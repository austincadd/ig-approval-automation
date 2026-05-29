import fs from 'node:fs';
import path from 'node:path';

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function readLockMetadata(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

function writeLockMetadata(lockFd, metadata) {
  const payload = JSON.stringify(metadata, null, 2);
  fs.writeFileSync(lockFd, `${payload}\n`, 'utf8');
}

export function acquireSingleInstanceLock({
  lockPath,
  label,
  metadata = {},
  allowStaleCleanup = true
}) {
  const resolvedLockPath = path.resolve(lockPath);
  fs.mkdirSync(path.dirname(resolvedLockPath), { recursive: true });

  try {
    const lockFd = fs.openSync(resolvedLockPath, 'wx');
    writeLockMetadata(lockFd, {
      pid: process.pid,
      label,
      startedAt: new Date().toISOString(),
      ...metadata
    });
    fs.closeSync(lockFd);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;

    const existing = readLockMetadata(resolvedLockPath);
    const existingPid = Number(existing?.pid);
    if (isProcessAlive(existingPid)) {
      const message = `${label} is already running (pid ${existingPid}). Lock: ${resolvedLockPath}`;
      const instanceError = new Error(message);
      instanceError.code = 'SINGLE_INSTANCE_ACTIVE';
      instanceError.lockPath = resolvedLockPath;
      instanceError.lockOwnerPid = existingPid;
      instanceError.lockOwner = existing;
      throw instanceError;
    }

    if (!allowStaleCleanup) {
      const staleError = new Error(`${label} found a stale lock at ${resolvedLockPath}`);
      staleError.code = 'SINGLE_INSTANCE_STALE_LOCK';
      staleError.lockPath = resolvedLockPath;
      staleError.lockOwner = existing;
      throw staleError;
    }

    fs.rmSync(resolvedLockPath, { force: true });
    return acquireSingleInstanceLock({
      lockPath: resolvedLockPath,
      label,
      metadata,
      allowStaleCleanup: false
    });
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      const current = readLockMetadata(resolvedLockPath);
      if (!current || Number(current.pid) === process.pid) {
        fs.rmSync(resolvedLockPath, { force: true });
      }
    } catch {}
  };

  return {
    path: resolvedLockPath,
    release
  };
}
