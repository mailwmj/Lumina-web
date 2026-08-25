import { existsSync } from 'node:fs';
import process from 'node:process';

import { createNativeJsonSession } from './nativeProcess.mjs';

const PYTHON_SCRIPT = String.raw`
import ctypes
import ctypes.util
import errno
import fcntl
import hashlib
import json
import os
import stat
import sys
import base64

F_FULLFSYNC = 51
libc = ctypes.CDLL(ctypes.util.find_library('c'), use_errno=True)

def durable_flush(path, directory):
    descriptor = os.open(path, (os.O_RDONLY if directory else os.O_RDWR) | os.O_NOFOLLOW)
    try:
        if not directory and libc.fcntl(descriptor, F_FULLFSYNC) != 0:
            failure = ctypes.get_errno()
            if failure not in (errno.EINVAL, errno.ENOTTY):
                raise OSError(failure, os.strerror(failure), path)
            os.fsync(descriptor)
        else:
            os.fsync(descriptor)
    finally:
        os.close(descriptor)

def replace(temporary, target):
    os.replace(temporary, target)

def managed_segments(relative):
    if not isinstance(relative, str) or relative in ('', '.'):
        return []
    if os.path.isabs(relative):
        raise OSError(errno.EPERM, 'managed path is rooted')
    segments = [segment for segment in relative.replace('\\', '/').split('/') if segment]
    if any(segment in ('.', '..') or '\\x00' in segment for segment in segments):
        raise OSError(errno.EPERM, 'managed path is invalid')
    return segments

def open_directory_chain(root, relative, create=False):
    descriptor = os.open(os.path.abspath(root), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    descriptors = [descriptor]
    try:
        for segment in managed_segments(relative):
            if create:
                try:
                    os.mkdir(segment, 0o700, dir_fd=descriptor)
                except FileExistsError:
                    pass
            next_descriptor = os.open(segment, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            descriptors.append(next_descriptor)
            descriptor = next_descriptor
        return descriptors
    except Exception:
        for opened in reversed(descriptors):
            os.close(opened)
        raise

def close_descriptors(descriptors):
    for descriptor in reversed(descriptors):
        os.close(descriptor)

def managed_parent(root, relative):
    segments = managed_segments(relative)
    if not segments:
        raise OSError(errno.EPERM, 'managed file path is missing')
    return open_directory_chain(root, '/'.join(segments[:-1])), segments[-1]

def regular_open(directory, name, flags):
    descriptor = os.open(name, flags | os.O_NOFOLLOW, dir_fd=directory)
    opened = os.fstat(descriptor)
    if not stat.S_ISREG(opened.st_mode):
        os.close(descriptor)
        raise OSError(errno.ELOOP, 'managed payload is not regular')
    return descriptor

def ensure_directory(root, relative):
    descriptors = open_directory_chain(root, relative, True)
    close_descriptors(descriptors)

def ensure_root_directory(root):
    absolute = os.path.abspath(root)
    descriptors = open_directory_chain('/', absolute.lstrip('/'), True)
    close_descriptors(descriptors)

open_managed_files = {}
next_open_managed_file = 0

def create_new_managed_file(root, relative):
    global next_open_managed_file
    directories, name = managed_parent(root, relative)
    try:
        descriptor = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directories[-1])
        opened = os.fstat(descriptor)
        if not stat.S_ISREG(opened.st_mode) or opened.st_size != 0:
            os.close(descriptor)
            close_descriptors(directories)
            raise OSError(errno.ELOOP, 'managed new file is not regular and empty')
        next_open_managed_file += 1
        token = str(next_open_managed_file)
        open_managed_files[token] = (descriptor, directories)
        return token
    except Exception:
        if 'descriptor' not in locals() or descriptor < 0:
            close_descriptors(directories)
        raise

def write_managed_file(token, encoded):
    descriptor, _directories = open_managed_files[token]
    return os.write(descriptor, base64.b64decode(encoded))

def close_managed_file(token):
    descriptor, directories = open_managed_files.pop(token)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
        close_descriptors(directories)

def replace_managed(root, temporary_relative, target_relative):
    source_directories, source_name = managed_parent(root, temporary_relative)
    target_directories, target_name = managed_parent(root, target_relative)
    try:
        source = regular_open(source_directories[-1], source_name, os.O_RDONLY)
        try:
            pinned = os.fstat(source)
            current = os.stat(source_name, dir_fd=source_directories[-1], follow_symlinks=False)
            if (not stat.S_ISREG(current.st_mode)
                    or current.st_dev != pinned.st_dev
                    or current.st_ino != pinned.st_ino):
                raise OSError(errno.ELOOP, 'managed replacement source changed')
            try:
                target = os.stat(target_name, dir_fd=target_directories[-1], follow_symlinks=False)
                if stat.S_ISLNK(target.st_mode):
                    raise OSError(errno.ELOOP, 'managed replacement target is a symlink')
            except FileNotFoundError:
                pass
            os.replace(source_name, target_name, src_dir_fd=source_directories[-1], dst_dir_fd=target_directories[-1])
        finally:
            os.close(source)
    finally:
        close_descriptors(target_directories)
        close_descriptors(source_directories)

def copy_file_managed(root, source_relative, target_relative):
    source_directories, source_name = managed_parent(root, source_relative)
    target_directories, target_name = managed_parent(root, target_relative)
    try:
        source = regular_open(source_directories[-1], source_name, os.O_RDONLY)
        try:
            target = os.open(target_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=target_directories[-1])
            try:
                while True:
                    chunk = os.read(source, 1024 * 1024)
                    if not chunk:
                        break
                    offset = 0
                    while offset < len(chunk):
                        offset += os.write(target, chunk[offset:])
                os.fsync(target)
            finally:
                os.close(target)
        finally:
            os.close(source)
    finally:
        close_descriptors(target_directories)
        close_descriptors(source_directories)

def remove_directory_managed(root, relative):
    directories, name = managed_parent(root, relative)
    try:
        target = os.stat(name, dir_fd=directories[-1], follow_symlinks=False)
        if stat.S_ISLNK(target.st_mode) or not stat.S_ISDIR(target.st_mode):
            raise OSError(errno.ELOOP, 'managed directory is not a directory')
        try:
            os.rmdir(name, dir_fd=directories[-1])
            return True
        except FileNotFoundError:
            return False
        except OSError as failure:
            if failure.errno == errno.ENOTEMPTY:
                return False
            raise
    finally:
        close_descriptors(directories)

def replace_if_current(temporary, target, lease_path, expected_contents, expires_at):
    if int(__import__('time').time() * 1000) >= expires_at:
        return False
    try:
        descriptor = os.open(lease_path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(descriptor, 'rb') as lease:
            fcntl.flock(lease.fileno(), fcntl.LOCK_EX)
            if lease.read().decode('utf-8') != expected_contents or int(__import__('time').time() * 1000) >= expires_at:
                return False
            replace(temporary, target)
            return True
    except FileNotFoundError:
        return False

def replace_if_current_managed(root, temporary_relative, target_relative, lease_relative, expected_contents, expires_at):
    if int(__import__('time').time() * 1000) >= expires_at:
        return False
    lease_directories, lease_name = managed_parent(root, lease_relative)
    try:
        descriptor = regular_open(lease_directories[-1], lease_name, os.O_RDONLY)
        with os.fdopen(descriptor, 'rb') as lease:
            fcntl.flock(lease.fileno(), fcntl.LOCK_EX)
            if lease.read().decode('utf-8') != expected_contents or int(__import__('time').time() * 1000) >= expires_at:
                return False
            replace_managed(root, temporary_relative, target_relative)
            return True
    except FileNotFoundError:
        return False
    finally:
        close_descriptors(lease_directories)

def remove_if_unchanged(root, relative, expected_text, expected_sha256):
    directories, name = managed_parent(root, relative)
    try:
        descriptor = regular_open(directories[-1], name, os.O_RDONLY)
        with os.fdopen(descriptor, 'rb') as source:
            fcntl.flock(source.fileno(), fcntl.LOCK_EX)
            opened = os.fstat(source.fileno())
            if expected_text is not None:
                matches = source.read().decode('utf-8') == expected_text
            else:
                digest = hashlib.sha256()
                while True:
                    chunk = source.read(1024 * 1024)
                    if not chunk:
                        break
                    digest.update(chunk)
                matches = digest.hexdigest() == expected_sha256
            if not matches:
                return False
            # Hold the exact inode lock through the final identity check and
            # unlink. Cooperative library writers cannot swap this path after
            # it has been authorized, and a non-matching path fails closed.
            current = os.stat(name, dir_fd=directories[-1], follow_symlinks=False)
            if (stat.S_ISLNK(current.st_mode)
                    or current.st_dev != opened.st_dev
                    or current.st_ino != opened.st_ino):
                return False
            os.unlink(name, dir_fd=directories[-1])
            return True
    except FileNotFoundError:
        return False
    finally:
        close_descriptors(directories)

def handle(request):
    operation = request['operation']
    if operation == 'flushFile':
        durable_flush(request['target'], False)
        result = True
    elif operation == 'syncDirectory':
        durable_flush(request['target'], True)
        result = True
    elif operation == 'atomicReplace':
      replace(request['temporary'], request['target'])
      result = True
    elif operation == 'ensureDirectory':
        ensure_directory(request['root'], request['relative'])
        result = True
    elif operation == 'ensureRootDirectory':
        ensure_root_directory(request['root'])
        result = True
    elif operation == 'createNewManagedFileManaged':
        result = create_new_managed_file(request['root'], request['relative'])
    elif operation == 'writeManagedFileManaged':
        result = write_managed_file(request['token'], request['bytesBase64'])
    elif operation == 'closeManagedFileManaged':
        close_managed_file(request['token'])
        result = True
    elif operation == 'atomicReplaceManaged':
        replace_managed(request['root'], request['temporaryRelative'], request['targetRelative'])
        result = True
    elif operation == 'atomicReplaceIfLeaseCurrent':
        result = replace_if_current(request['temporary'], request['target'], request['leasePath'], request['expectedContents'], request['expiresAt'])
    elif operation == 'atomicReplaceIfLeaseCurrentManaged':
        result = replace_if_current_managed(request['root'], request['temporaryRelative'], request['targetRelative'], request['leaseRelative'], request['expectedContents'], request['expiresAt'])
    elif operation == 'copyFileManaged':
        copy_file_managed(request['root'], request['sourceRelative'], request['targetRelative'])
        result = True
    elif operation == 'removeDirectoryManaged':
        result = remove_directory_managed(request['root'], request['relative'])
    elif operation == 'removeIfUnchanged':
        result = remove_if_unchanged(request['root'], request['relative'], request.get('expectedText'), request.get('expectedSha256'))
    else:
        raise RuntimeError('Unsupported durable operation')
    return result

for line in sys.stdin:
    try:
        result = handle(json.loads(line))
        print(json.dumps({'ok': True, 'result': result}), flush=True)
    except Exception as failure:
        code = 'ELOOP' if isinstance(failure, OSError) and failure.errno == errno.ELOOP else 'ENOTSUP'
        print(json.dumps({'ok': False, 'code': code, 'message': str(failure)}), flush=True)
`;

export function createMacosDurableFileOps() {
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/python3')) return null;
  const session = createNativeJsonSession('/usr/bin/python3', ['-c', PYTHON_SCRIPT]);
  const releases = new Map();
  const invoke = (operation, payload) => session.request({ operation, ...payload });
  const createNewManagedFileManaged = async (root, relative) => {
    const token = await invoke('createNewManagedFileManaged', { root, relative });
    releases.set(token, session.retain());
    return token;
  };
  return Object.freeze({
    flushFile: (target) => invoke('flushFile', { target }),
    syncDirectory: (target) => invoke('syncDirectory', { target }),
    ensureDirectory: (root, relative) => invoke('ensureDirectory', { root, relative }),
    ensureRootDirectory: (root) => invoke('ensureRootDirectory', { root }),
    createNewManagedFileManaged,
    writeManagedFileManaged: (root, token, bytes) => invoke('writeManagedFileManaged', {
      root, token, bytesBase64: Buffer.from(bytes).toString('base64'),
    }),
    closeManagedFileManaged: async (root, token) => {
      try {
        return await invoke('closeManagedFileManaged', { root, token });
      } finally {
        const release = releases.get(token);
        releases.delete(token);
        release?.();
      }
    },
    atomicReplace: (temporary, target) => invoke('atomicReplace', { temporary, target }),
    atomicReplaceManaged: (root, temporaryRelative, targetRelative) => invoke(
      'atomicReplaceManaged', { root, temporaryRelative, targetRelative },
    ),
    atomicReplaceIfLeaseCurrent: (temporary, target, leasePath, expectedContents, expiresAt) => invoke(
      'atomicReplaceIfLeaseCurrent',
      { temporary, target, leasePath, expectedContents, expiresAt },
    ),
    atomicReplaceIfLeaseCurrentManaged: (root, temporaryRelative, targetRelative, leaseRelative, expectedContents, expiresAt) => invoke(
      'atomicReplaceIfLeaseCurrentManaged', { root, temporaryRelative, targetRelative, leaseRelative, expectedContents, expiresAt },
    ),
    copyFileManaged: (root, sourceRelative, targetRelative) => invoke(
      'copyFileManaged', { root, sourceRelative, targetRelative },
    ),
    removeDirectoryManaged: (root, relative) => invoke('removeDirectoryManaged', { root, relative }),
    removeIfUnchanged: (root, relative, expectedContents) => invoke('removeIfUnchanged', {
      root,
      relative,
      expectedText: typeof expectedContents === 'string' ? expectedContents : null,
      expectedSha256: typeof expectedContents === 'string' ? null : expectedContents?.sha256 ?? null,
    }),
  });
}
