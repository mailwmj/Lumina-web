import { CorruptLibraryError, DEFAULT_SAFETY_WINDOW_MS, FileProjectLibraryError, KEY_PATTERN, LIBRARY_FORMAT, LIBRARY_VERSION, MAX_DURABLE_ASSET_BYTES, MAX_PROJECT_DOCUMENT_BYTES, MAX_WRITE_LEASE_MS, canonicalize, compareUtf8, createHash, decoder, encoder, fs, fsConstants, parseStrictJson, path, randomUUID, sha256 } from './core.mjs';

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
  await ensureNoSymlinkPath(state, target, true);
  await fs.mkdir(target, { recursive: true });
  await ensureNoSymlinkPath(state, target);
}

export async function ensureParentDirectory(state, target) {
  const parent = path.dirname(target);
  const relative = path.relative(state.root, parent);
  await ensureDirectory(state, relative);
}

export async function ensureNoSymlinkPath(stateOrRoot, target, allowMissing = true) {
  const state = typeof stateOrRoot === 'object' && stateOrRoot !== null && typeof stateOrRoot.root === 'string'
    ? stateOrRoot
    : null;
  const root = state?.root ?? stateOrRoot;
  const absoluteRoot = path.resolve(root);
  const absoluteTarget = path.resolve(target);
  const relation = path.relative(absoluteRoot, absoluteTarget);
  if (relation === '..' || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    throw new FileProjectLibraryError('path_escape', 'Path escapes the managed root.');
  }
  const segments = relation ? relation.split(path.sep) : [];
  const rootStat = await fs.lstat(absoluteRoot);
  await assertSafeManagedEntry(state, absoluteRoot, rootStat, true);
  const canonicalRoot = await fs.realpath(absoluteRoot);
  await assertSafeManagedEntry(state, absoluteRoot, await fs.lstat(absoluteRoot), true);
  let current = absoluteRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      await assertSafeManagedEntry(state, current, stat, current !== absoluteTarget);
      if (stat.isDirectory() === false && current !== absoluteTarget) {
        throw new FileProjectLibraryError('path_escape', 'Managed path contains a non-directory segment.');
      }
      let canonicalTarget;
      try {
        canonicalTarget = await fs.realpath(current);
      } catch (error) {
        if (process.platform !== 'win32' || current !== absoluteTarget || error?.code !== 'EPERM') {
          throw error;
        }
        const lockedTargetStat = await fs.lstat(current);
        await assertSafeManagedEntry(state, current, lockedTargetStat, false);
        if (!lockedTargetStat.isFile()) {
          throw new FileProjectLibraryError('path_escape', 'A locked managed target must be a regular file.');
        }
        continue;
      }
      const currentStat = await fs.lstat(current);
      await assertSafeManagedEntry(state, current, currentStat, current !== absoluteTarget);
      if (currentStat.isDirectory() === false && current !== absoluteTarget) {
        throw new FileProjectLibraryError('path_escape', 'Managed path contains a non-directory segment.');
      }
      await assertCanonicalManagedPath(canonicalRoot, canonicalTarget);
    } catch (error) {
      if (allowMissing && (
        error?.code === 'ENOENT'
        || (process.platform === 'win32'
          && error?.code === 'EBADF'
          && current === absoluteTarget
          && path.resolve(state?.lockPath ?? '') === current)
      )) break;
      throw error;
    }
  }
}

export async function ensureNoSymlinkAncestors(stateOrTarget, target = undefined) {
  const state = target === undefined ? null : stateOrTarget;
  const selectedTarget = target ?? stateOrTarget;
  const absolute = path.resolve(selectedTarget);
  const parsed = path.parse(absolute);
  const segments = path.relative(parsed.root, absolute).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      await assertSafeManagedEntry(state, current, stat, true);
      if (!stat.isDirectory()) throw new FileProjectLibraryError('invalid_root', 'The managed root contains a non-directory ancestor.');
    } catch (error) {
      if (error?.code === 'ENOENT') break;
      throw error;
    }
  }
}

async function assertSafeManagedEntry(state, target, stat, requireDirectory) {
  if (stat.isSymbolicLink()) {
    throw new FileProjectLibraryError('path_escape', 'Managed paths cannot contain symlinks, junctions, or reparse points.');
  }
  if (requireDirectory && !stat.isDirectory()) {
    throw new FileProjectLibraryError('path_escape', 'Managed path contains a non-directory segment.');
  }
  if (process.platform !== 'win32' || typeof state?.durableFileOps?.isReparsePoint !== 'function') return;
  let isReparsePoint;
  try {
    isReparsePoint = await state.durableFileOps.isReparsePoint(target);
  } catch (error) {
    if (error?.code === 'ENOENT') throw error;
    throw new FileProjectLibraryError(
      'durability_unavailable',
      'The managed filesystem cannot validate Windows reparse-point safety.',
      { cause: error },
    );
  }
  if (typeof isReparsePoint !== 'boolean') {
    throw new FileProjectLibraryError(
      'durability_unavailable',
      'The managed filesystem must report Windows reparse-point safety.',
    );
  }
  if (isReparsePoint) {
    throw new FileProjectLibraryError('path_escape', 'Managed paths cannot contain symlinks, junctions, or reparse points.');
  }
}

async function assertCanonicalManagedPath(canonicalRoot, canonicalTarget) {
  const relation = path.relative(canonicalRoot, canonicalTarget);
  if (relation === '..' || relation.startsWith('..' + path.sep) || path.isAbsolute(relation)) {
    throw new FileProjectLibraryError('path_escape', 'Managed path resolves outside the canonical library root.');
  }
}

export async function acquireWriteLease(state) {
  const deadline = Date.now() + state.lockTimeoutMs;
  while (true) {
    try {
      const acquiredAt = Date.now();
      const token = randomUUID();
      const contents = `${process.pid}\n${acquiredAt}\n${token}\n`;
      await ensureNoSymlinkPath(state, state.lockPath, true);
      const handle = await openNewManagedFile(state, state.lockPath, 'write lease');
      try {
        await ensureNoSymlinkPath(state, state.lockPath);
        await handle.writeFile(contents, 'utf8');
      } finally {
        await handle.close();
      }
      await flushFile(state, state.lockPath);
      await syncDirectory(state, path.dirname(state.lockPath));
      return { path: state.lockPath, acquiredAt, token, contents };
    } catch (error) {
      if (!['EEXIST', 'EPERM'].includes(error?.code)) throw error;
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
    await ensureNoSymlinkPath(state, state.lockPath);
    stat = await fs.lstat(state.lockPath);
    contents = await readWriteLeaseContents(state, state.lockPath);
  } catch (error) {
    if (['ENOENT', 'EPERM', 'corrupt_schema'].includes(error?.code)) return;
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
    const contents = await readWriteLeaseContents(state, lock.path);
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
    contents = await readWriteLeaseContents(state, lease.path);
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
  await ensureNoSymlinkPath(state, target, true);
  await ensureParentDirectory(state, target);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeNewManagedFile(state, temporary, bytes);
  await flushFile(state, temporary);
  await atomicReplace(state, temporary, target);
  await flushFile(state, target);
  await syncDirectory(state, path.dirname(target));
}

export async function writeCanonicalHeadBytes(state, target, bytes) {
  await ensureNoSymlinkPath(state, target, true);
  await ensureParentDirectory(state, target);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let published = false;
  try {
    await writeNewManagedFile(state, temporary, bytes);
    await flushFile(state, temporary);
    await atomicReplaceIfLeaseCurrent(state, temporary, target);
    published = true;
  } finally {
    if (!published) {
      const removed = await removeIfUnchanged(state, temporary, { sha256: sha256(bytes) }).catch(() => false);
      if (removed) await syncDirectory(state, path.dirname(temporary)).catch(() => {});
    }
  }
  await flushFile(state, target);
  await syncDirectory(state, path.dirname(target));
}

async function writeNewManagedFile(state, target, bytes) {
  const handle = await openNewManagedFile(state, target, 'new managed file');
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
}

export async function openNewManagedFile(state, target, label) {
  await ensureNoSymlinkPath(state, target, true);
  let handle;
  try {
    handle = await fs.open(target, newManagedFileFlags());
  } catch (error) {
    throw translateManagedOpenError(error, label);
  }
  try {
    const { stat } = await assertManagedFileHandle(state, target, handle, null, label);
    if (!stat.isFile() || stat.size !== 0) {
      throw new FileProjectLibraryError('path_escape', `${label} is not a new regular managed file.`);
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function openManagedFileForRead(state, target, maxBytes, label, invalidFileError = undefined) {
  await ensureNoSymlinkPath(state, target);
  const initial = await fs.lstat(target, { bigint: true });
  if (initial.isSymbolicLink() || !initial.isFile() || initial.size > BigInt(maxBytes)) {
    throw invalidFileError ?? new FileProjectLibraryError(
      'path_escape',
      `${label} exceeds its configured byte limit or is not a regular managed file.`,
    );
  }
  let handle;
  try {
    handle = await fs.open(target, existingManagedFileFlags());
  } catch (error) {
    throw translateManagedOpenError(error, label);
  }
  try {
    const opened = await assertManagedFileHandle(state, target, handle, initial, label);
    if (opened.stat.size > maxBytes) {
      throw new FileProjectLibraryError('path_escape', `${label} changed before it could be opened safely.`);
    }
    return { handle, ...opened };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function assertManagedFileHandle(state, target, handle, expectedStat, label) {
  const stat = await handle.stat();
  const identity = await handle.stat({ bigint: true });
  if (!stat.isFile()) {
    throw new FileProjectLibraryError('path_escape', `${label} opened a non-regular managed file.`);
  }
  await ensureNoSymlinkPath(state, target);
  const pathname = await fs.lstat(target, { bigint: true });
  if (!pathname.isFile() || !sameFileIdentity(pathname, identity)
    || (expectedStat && !sameFileIdentity(expectedStat, identity))) {
    throw new FileProjectLibraryError('path_escape', `${label} changed while its managed path was opened.`);
  }
  return { stat, identity };
}

function existingManagedFileFlags() {
  return process.platform === 'win32'
    ? 'r'
    : fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
}

function newManagedFileFlags() {
  return process.platform === 'win32'
    ? 'wx'
    : fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0);
}

function sameFileIdentity(left, right) {
  return [left?.dev, left?.ino, right?.dev, right?.ino].every((value) => typeof value === 'bigint')
    && left.ino > 0
    && right.ino > 0
    && left.dev === right.dev
    && left.ino === right.ino;
}

function translateManagedOpenError(error, label) {
  if (error?.code === 'ELOOP') {
    return new FileProjectLibraryError('path_escape', `${label} is a symlink or reparse point.`, { cause: error });
  }
  return error;
}

export async function readFileBytesBounded(state, target, maxBytes, label) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error('A bounded file read requires a non-negative safe integer limit.');
  }
  const { handle, stat: opened, identity } = await openManagedFileForRead(
    state,
    target,
    maxBytes,
    label,
    new CorruptLibraryError(`${label} exceeds its configured byte limit or is not a regular file.`),
  );
  try {
    const bytes = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (bytesRead === 0) throw new CorruptLibraryError(`${label} was truncated while being read.`);
      offset += bytesRead;
    }
    const finished = await handle.stat();
    const finishedIdentity = await handle.stat({ bigint: true });
    if (!finished.isFile() || !sameFileIdentity(identity, finishedIdentity)
      || finished.size !== opened.size || finished.size > maxBytes) {
      throw new CorruptLibraryError(`${label} changed while being read safely.`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

export async function hashFileBytes(state, target, maxBytes = MAX_DURABLE_ASSET_BYTES) {
  const { handle, stat: opened, identity } = await openManagedFileForRead(
    state,
    target,
    maxBytes,
    'managed payload',
    new FileProjectLibraryError('payload_too_large', 'A managed file exceeds its configured limit or is not regular.'),
  );
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
  const finished = await fs.lstat(target, { bigint: true });
  if (!finished.isFile() || !sameFileIdentity(identity, finished)) {
    throw new FileProjectLibraryError('path_escape', 'A managed payload changed while being hashed.');
  }
  return { byteCount, sha256: digest.digest('hex') };
}

export async function fileDigestIfExists(state, relative) {
  const target = managedPath(state, relative);
  try {
    await ensureNoSymlinkPath(state, target);
    return await hashFileBytes(state, target);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function readWriteLeaseContents(state, target) {
  return decoder.decode(await readFileBytesBounded(state, target, MAX_WRITE_LEASE_BYTES, 'write lease'));
}

export async function readCanonicalFile(state, target, label, maxBytes = MAX_PROJECT_DOCUMENT_BYTES) {
  await ensureNoSymlinkPath(state, target);
  const bytes = await readFileBytesBounded(state, target, maxBytes, label);
  const value = parseStrictJson(bytes, label);
  if (canonicalize(value) !== decoder.decode(bytes)) throw new CorruptLibraryError(`${label} is not canonical.`);
  return bytes;
}

export async function flushFile(state, target) {
  await ensureNoSymlinkPath(state, target);
  await runDurableOperation(state, 'flushFile', [target], 'The managed filesystem cannot flush files.');
}

export async function atomicReplace(state, temporary, target) {
  await ensureNoSymlinkPath(state, temporary);
  await ensureNoSymlinkPath(state, target, true);
  await runDurableOperation(
    state,
    'atomicReplace',
    [temporary, target],
    'The managed filesystem cannot atomically replace files.',
  );
  await ensureNoSymlinkPath(state, target);
}

export async function atomicReplaceIfLeaseCurrent(state, temporary, target) {
  const lease = state.activeWriteLease;
  if (!lease) {
    throw new FileProjectLibraryError('lease_lost', 'The library write lease was replaced before publication.');
  }
  await ensureNoSymlinkPath(state, temporary);
  await ensureNoSymlinkPath(state, target, true);
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
  await ensureNoSymlinkPath(state, target);
}

export async function removeIfUnchanged(state, target, expectedContents) {
  await ensureNoSymlinkPath(state, target);
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

export async function captureManagedTreeClosure(state, directory, label) {
  const root = path.resolve(directory);
  const entries = [];
  for (const target of await collectFiles(state, root)) {
    const relative = path.relative(root, target).replaceAll('\\', '/');
    if (relative === '' || relative.startsWith('../') || path.isAbsolute(relative)) {
      throw new FileProjectLibraryError('path_escape', `${label} escapes its managed directory.`);
    }
    entries.push({ path: relative, sha256: (await hashFileBytes(state, target)).sha256 });
  }
  entries.sort((left, right) => compareUtf8(left.path, right.path));
  return entries;
}

export async function removeExactManagedTree(state, directory, expectedEntries, label) {
  if (!Array.isArray(expectedEntries)) {
    throw new TypeError('Exact managed tree removal requires an expected file closure.');
  }
  const expected = [...expectedEntries].sort((left, right) => compareUtf8(left.path, right.path));
  const actual = await captureManagedTreeClosure(state, directory, label);
  if (actual.length !== expected.length || actual.some((entry, index) => (
    entry.path !== expected[index]?.path || entry.sha256 !== expected[index]?.sha256
  ))) {
    throw new FileProjectLibraryError(
      'recovery_required',
      `${label} changed before exact cleanup.`,
    );
  }
  for (const entry of expected) {
    const target = path.join(directory, ...entry.path.split('/'));
    await assertWriteLeaseCurrent(state);
    if (!(await removeIfUnchanged(state, target, { sha256: entry.sha256 }))) {
      throw new FileProjectLibraryError(
        'recovery_required',
        `${label} changed before exact cleanup.`,
      );
    }
    await syncDirectory(state, path.dirname(target));
  }
  const directories = await collectManagedDirectories(state, directory);
  for (const target of directories.sort((left, right) => right.length - left.length)) {
    await ensureNoSymlinkPath(state, target);
    try {
      await fs.rmdir(target);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      if (error?.code === 'ENOTEMPTY' || error?.code === 'EEXIST') {
        throw new FileProjectLibraryError(
          'recovery_required',
          `${label} changed before its empty directories could be removed.`,
        );
      }
      throw error;
    }
    await syncDirectory(state, path.dirname(target));
  }
}

export async function syncDirectory(state, directory) {
  const root = path.resolve(state.root);
  let current = path.resolve(directory);
  while (true) {
    await ensureNoSymlinkPath(state, current);
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
    )
    || (process.platform === 'win32' && typeof state.durableFileOps.isReparsePoint !== 'function')) {
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
    if (error?.code === 'ELOOP') {
      throw new FileProjectLibraryError('path_escape', 'The managed filesystem opened a symlink or reparse point.', { cause: error });
    }
    if (['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EISDIR'].includes(error?.code)) {
      throw new FileProjectLibraryError('durability_unavailable', message, { cause: error });
    }
    throw error;
  }
}

export async function fault(state, phase, details) {
  if (state.faultInjector) await state.faultInjector(phase, details);
}

export async function collectFiles(state, directory) {
  const result = [];
  let entries;
  try {
    await ensureNoSymlinkPath(state, directory);
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return result;
    throw error;
  }
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    await ensureNoSymlinkPath(state, entryPath);
    if (entry.isDirectory()) result.push(...(await collectFiles(state, entryPath)));
    else result.push(entryPath);
  }
  return result;
}

async function collectManagedDirectories(state, directory) {
  let entries;
  try {
    await ensureNoSymlinkPath(state, directory);
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const result = [directory];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    await ensureNoSymlinkPath(state, target);
    if (entry.isDirectory()) result.push(...(await collectManagedDirectories(state, target)));
  }
  return result;
}

export async function pathExists(state, target) {
  try {
    await ensureNoSymlinkPath(state, target);
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
    await ensureNoSymlinkPath(state, directory);
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      await ensureNoSymlinkPath(state, path.join(directory, entry.name));
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
