import { CorruptLibraryError, DEFAULT_SAFETY_WINDOW_MS, FileProjectLibraryError, KEY_PATTERN, LIBRARY_FORMAT, LIBRARY_VERSION, MAX_DURABLE_ASSET_BYTES, MAX_PROJECT_DOCUMENT_BYTES, MAX_WRITE_LEASE_MS, canonicalize, createHash, decoder, encoder, fs, parseStrictJson, path, randomUUID } from './core.mjs';

const MAX_WRITE_LEASE_BYTES = 4096;

export function managedPath(state, relative) {
  if (typeof relative !== 'string' || relative.includes('\u0000')) {
    throw new FileProjectLibraryError('path_escape', 'Managed path is invalid.');
  }
  const target = path.resolve(state.root, relative);
  const relation = path.relative(state.root, target);
  if (relation === '..' || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    throw new FileProjectLibraryError('path_escape', 'Managed path escapes the library root.');
  }
  return target;
}

export async function ensureDirectory(state, relative) {
  const target = managedPath(state, relative);
  await ensureNoSymlinkPath(state.root, target, true);
  await fs.mkdir(target, { recursive: true });
  await ensureNoSymlinkPath(state.root, target);
}

export async function ensureParentDirectory(state, target) {
  const parent = path.dirname(target);
  const relative = path.relative(state.root, parent);
  await ensureDirectory(state, relative);
}

export async function ensureNoSymlinkPath(root, target, allowMissing = true) {
  const absoluteRoot = path.resolve(root);
  const absoluteTarget = path.resolve(target);
  const relation = path.relative(absoluteRoot, absoluteTarget);
  if (relation === '..' || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    throw new FileProjectLibraryError('path_escape', 'Path escapes the managed root.');
  }
  const segments = relation ? relation.split(path.sep) : [];
  let current = absoluteRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new FileProjectLibraryError('path_escape', 'Managed paths cannot contain symlinks.');
      if (stat.isDirectory() === false && current !== absoluteTarget) {
        throw new FileProjectLibraryError('path_escape', 'Managed path contains a non-directory segment.');
      }
    } catch (error) {
      if (error?.code === 'ENOENT' && allowMissing) break;
      throw error;
    }
  }
}

export async function ensureNoSymlinkAncestors(target) {
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  const segments = path.relative(parsed.root, absolute).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new FileProjectLibraryError('path_escape', 'The managed root cannot contain symlinks.');
      if (!stat.isDirectory()) throw new FileProjectLibraryError('invalid_root', 'The managed root contains a non-directory ancestor.');
    } catch (error) {
      if (error?.code === 'ENOENT') break;
      throw error;
    }
  }
}

export async function acquireWriteLease(state) {
  const deadline = Date.now() + state.lockTimeoutMs;
  while (true) {
    try {
      const acquiredAt = Date.now();
      const token = randomUUID();
      const contents = `${process.pid}\n${acquiredAt}\n${token}\n`;
      const handle = await fs.open(state.lockPath, 'wx');
      try {
        await handle.writeFile(contents, 'utf8');
      } finally {
        await handle.close();
      }
      await flushFile(state, state.lockPath);
      await syncDirectory(state, path.dirname(state.lockPath));
      return { path: state.lockPath, acquiredAt, token, contents };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      await removeStaleLease(state);
      if (Date.now() >= deadline) throw new FileProjectLibraryError('library_busy', 'The project library write lease is busy.');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

export async function removeStaleLease(state) {
  let stat;
  let contents;
  try {
    [stat, contents] = await Promise.all([
      fs.stat(state.lockPath),
      readWriteLeaseContents(state.lockPath),
    ]);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  const fields = contents.split(/\s+/u);
  const createdAt = Number.parseInt(fields[1], 10);
  const now = Date.now();
  let leaseExpired = false;
  if (Number.isSafeInteger(createdAt)) {
    const age = now - createdAt;
    if (age < state.lockTimeoutMs) return;
    leaseExpired = age >= MAX_WRITE_LEASE_MS;
  } else if (now - stat.mtimeMs < state.lockTimeoutMs) {
    return;
  }
  if (!leaseExpired) {
    const pid = Number.parseInt(fields[0], 10);
    if (Number.isInteger(pid) && pid > 0 && pid <= 0x7fffffff) {
      try {
        process.kill(pid, 0);
        return;
      } catch (error) {
        if (error?.code === 'EPERM') return;
      }
    }
  }
  if (await removeIfUnchanged(state, state.lockPath, contents)) {
    await syncDirectory(state, path.dirname(state.lockPath));
  }
}

export async function releaseWriteLease(state, lock) {
  try {
    const contents = await readWriteLeaseContents(lock.path);
    if (contents.split(/\s+/u)[2] !== lock.token) return;
    if (await removeIfUnchanged(state, lock.path, contents)) {
      await syncDirectory(state, path.dirname(lock.path));
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

export async function assertWriteLeaseCurrent(state) {
  const lease = state.activeWriteLease;
  if (!lease || Date.now() - lease.acquiredAt >= MAX_WRITE_LEASE_MS) {
    throw new FileProjectLibraryError(
      'lease_expired',
      'The final library publication lease exceeded its five-minute bound.',
    );
  }
  let contents;
  try {
    contents = await readWriteLeaseContents(lease.path);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new FileProjectLibraryError('lease_lost', 'The library write lease was replaced before publication.');
    }
    throw error;
  }
  if (contents.split(/\s+/u)[2] !== lease.token) {
    throw new FileProjectLibraryError('lease_lost', 'The library write lease was replaced before publication.');
  }
}

export async function writeCanonicalFile(state, target, value) {
  return writeCanonicalBytes(state, target, encoder.encode(canonicalize(value)));
}

export async function writeCanonicalHeadFile(state, target, value) {
  return writeCanonicalHeadBytes(state, target, encoder.encode(canonicalize(value)));
}

export async function writeCanonicalBytes(state, target, bytes) {
  await ensureNoSymlinkPath(state.root, target, true);
  await ensureParentDirectory(state, target);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, bytes);
  await flushFile(state, temporary);
  await atomicReplace(state, temporary, target);
  await flushFile(state, target);
  await syncDirectory(state, path.dirname(target));
}

export async function writeCanonicalHeadBytes(state, target, bytes) {
  await ensureNoSymlinkPath(state.root, target, true);
  await ensureParentDirectory(state, target);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let published = false;
  try {
    await fs.writeFile(temporary, bytes);
    await flushFile(state, temporary);
    await atomicReplaceIfLeaseCurrent(state, temporary, target);
    published = true;
  } finally {
    if (!published) await fs.rm(temporary, { force: true }).catch(() => {});
  }
  await flushFile(state, target);
  await syncDirectory(state, path.dirname(target));
}

export async function readFileBytesBounded(target, maxBytes, label) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error('A bounded file read requires a non-negative safe integer limit.');
  }
  await ensureNoSymlinkAncestors(path.dirname(target));
  const initial = await fs.lstat(target);
  if (initial.isSymbolicLink() || !initial.isFile() || initial.size > maxBytes) {
    throw new CorruptLibraryError(`${label} exceeds its configured byte limit or is not a regular file.`);
  }
  const handle = await fs.open(target, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > maxBytes || opened.size !== initial.size) {
      throw new CorruptLibraryError(`${label} changed before it could be read safely.`);
    }
    const bytes = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (bytesRead === 0) throw new CorruptLibraryError(`${label} was truncated while being read.`);
      offset += bytesRead;
    }
    const finished = await handle.stat();
    if (!finished.isFile() || finished.size !== opened.size || finished.size > maxBytes) {
      throw new CorruptLibraryError(`${label} changed while being read safely.`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

export async function hashFileBytes(target, maxBytes = MAX_DURABLE_ASSET_BYTES) {
  const handle = await fs.open(target, 'r');
  const digest = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let byteCount = 0;
  try {
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      byteCount += bytesRead;
      if (byteCount > maxBytes) {
        throw new FileProjectLibraryError('payload_too_large', 'A managed file exceeds its configured limit.');
      }
      digest.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return { byteCount, sha256: digest.digest('hex') };
}

export async function fileDigestIfExists(state, relative) {
  const target = managedPath(state, relative);
  try {
    await ensureNoSymlinkPath(state.root, target);
    return await hashFileBytes(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function readWriteLeaseContents(target) {
  return decoder.decode(await readFileBytesBounded(target, MAX_WRITE_LEASE_BYTES, 'write lease'));
}

export async function readCanonicalFile(target, label, maxBytes = MAX_PROJECT_DOCUMENT_BYTES) {
  await ensureNoSymlinkAncestors(path.dirname(target));
  const bytes = await readFileBytesBounded(target, maxBytes, label);
  const value = parseStrictJson(bytes, label);
  if (canonicalize(value) !== decoder.decode(bytes)) throw new CorruptLibraryError(`${label} is not canonical.`);
  return bytes;
}

export async function flushFile(state, target) {
  await runDurableOperation(state, 'flushFile', [target], 'The managed filesystem cannot flush files.');
}

export async function atomicReplace(state, temporary, target) {
  await runDurableOperation(
    state,
    'atomicReplace',
    [temporary, target],
    'The managed filesystem cannot atomically replace files.',
  );
}

export async function atomicReplaceIfLeaseCurrent(state, temporary, target) {
  const lease = state.activeWriteLease;
  if (!lease) {
    throw new FileProjectLibraryError('lease_lost', 'The library write lease was replaced before publication.');
  }
  const result = await runDurableOperation(
    state,
    'atomicReplaceIfLeaseCurrent',
    [temporary, target, lease.path, lease.contents, lease.acquiredAt + MAX_WRITE_LEASE_MS],
    'The managed filesystem cannot atomically publish the head while its write lease is current.',
    true,
  );
  if (typeof result !== 'boolean') {
    throw new FileProjectLibraryError(
      'durability_unavailable',
      'The managed filesystem must report whether it atomically published the head under the write lease.',
    );
  }
  if (!result) {
    throw new FileProjectLibraryError('lease_lost', 'The library write lease was replaced before publication.');
  }
}

export async function removeIfUnchanged(state, target, expectedContents) {
  const result = await runDurableOperation(
    state,
    'removeIfUnchanged',
    [target, expectedContents],
    'The managed filesystem cannot atomically reclaim a matching write lease.',
    true,
  );
  if (typeof result !== 'boolean') {
    throw new FileProjectLibraryError(
      'durability_unavailable',
      'The managed filesystem must report whether it atomically reclaimed the matching write lease.',
    );
  }
  return result;
}

export async function syncDirectory(state, directory) {
  const root = path.resolve(state.root);
  let current = path.resolve(directory);
  while (true) {
    await ensureNoSymlinkPath(state.root, current);
    await runDurableOperation(state, 'syncDirectory', [current], 'The managed filesystem cannot sync directories.');
    if (current === root) return;
    const parent = path.dirname(current);
    if (parent === current) {
      throw new FileProjectLibraryError('path_escape', 'A directory sync escaped the managed root.');
    }
    current = parent;
  }
}

export function assertDurableFileOps(state) {
  if (!state.durableFileOps
    || ['flushFile', 'atomicReplace', 'atomicReplaceIfLeaseCurrent', 'removeIfUnchanged', 'syncDirectory'].some(
      (operation) => typeof state.durableFileOps[operation] !== 'function',
    )) {
    throw new FileProjectLibraryError(
      'durability_unavailable',
      'The managed filesystem requires a complete DurableFileOps implementation.',
    );
  }
}

export async function runDurableOperation(state, operation, arguments_, message, allowFalse = false) {
  assertDurableFileOps(state);
  try {
    const result = await state.durableFileOps[operation](...arguments_);
    if (result === false && !allowFalse) throw new FileProjectLibraryError('durability_unavailable', message);
    return result;
  } catch (error) {
    if (error instanceof FileProjectLibraryError) throw error;
    if (['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EISDIR'].includes(error?.code)) {
      throw new FileProjectLibraryError('durability_unavailable', message, { cause: error });
    }
    throw error;
  }
}

export async function fault(state, phase, details) {
  if (state.faultInjector) await state.faultInjector(phase, details);
}

export async function collectFiles(directory) {
  const result = [];
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return result;
    throw error;
  }
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new FileProjectLibraryError('path_escape', 'Symlinks are not allowed in the library.');
    if (entry.isDirectory()) result.push(...(await collectFiles(entryPath)));
    else result.push(entry.name);
  }
  return result.map((entry) => path.isAbsolute(entry) ? entry : path.join(directory, entry));
}

export async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export async function listDirectories(state, relative) {
  const directory = managedPath(state, relative);
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new FileProjectLibraryError('path_escape', 'Symlinks are not allowed in the library.');
    }
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

export const FILE_PROJECT_LIBRARY_CONSTANTS = Object.freeze({
  libraryFormat: LIBRARY_FORMAT,
  libraryVersion: LIBRARY_VERSION,
  libraryKeyPattern: KEY_PATTERN.source,
  safetyWindowMs: DEFAULT_SAFETY_WINDOW_MS,
});
