import { existsSync } from 'node:fs';
import process from 'node:process';

import { runNativeJsonProcess } from './nativeProcess.mjs';

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

F_FULLFSYNC = 51
libc = ctypes.CDLL(ctypes.util.find_library('c'), use_errno=True)

def durable_flush(path, directory):
    descriptor = os.open(path, os.O_RDONLY if directory else os.O_RDWR)
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

def replace_if_current(temporary, target, lease_path, expected_contents, expires_at):
    if int(__import__('time').time() * 1000) >= expires_at:
        return False
    try:
        with open(lease_path, 'rb') as lease:
            fcntl.flock(lease.fileno(), fcntl.LOCK_EX)
            if lease.read().decode('utf-8') != expected_contents or int(__import__('time').time() * 1000) >= expires_at:
                return False
            replace(temporary, target)
            return True
    except FileNotFoundError:
        return False

def remove_if_unchanged(target, expected_text, expected_sha256):
    try:
        descriptor = os.open(target, os.O_RDONLY | os.O_NOFOLLOW)
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
            current = os.lstat(target)
            if (stat.S_ISLNK(current.st_mode)
                    or current.st_dev != opened.st_dev
                    or current.st_ino != opened.st_ino):
                return False
            os.unlink(target)
            return True
    except FileNotFoundError:
        return False

try:
    request = json.loads(sys.stdin.read())
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
    elif operation == 'atomicReplaceIfLeaseCurrent':
        result = replace_if_current(request['temporary'], request['target'], request['leasePath'], request['expectedContents'], request['expiresAt'])
    elif operation == 'removeIfUnchanged':
        result = remove_if_unchanged(request['target'], request.get('expectedText'), request.get('expectedSha256'))
    else:
        raise RuntimeError('Unsupported durable operation')
    print(json.dumps({'ok': True, 'result': result}))
except Exception as failure:
    print(json.dumps({'ok': False, 'code': 'ENOTSUP', 'message': str(failure)}))
`;

export function createMacosDurableFileOps() {
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/python3')) return null;
  const invoke = (operation, payload) => runNativeJsonProcess('/usr/bin/python3', ['-c', PYTHON_SCRIPT], { operation, ...payload });
  return Object.freeze({
    flushFile: (target) => invoke('flushFile', { target }),
    syncDirectory: (target) => invoke('syncDirectory', { target }),
    atomicReplace: (temporary, target) => invoke('atomicReplace', { temporary, target }),
    atomicReplaceIfLeaseCurrent: (temporary, target, leasePath, expectedContents, expiresAt) => invoke(
      'atomicReplaceIfLeaseCurrent',
      { temporary, target, leasePath, expectedContents, expiresAt },
    ),
    removeIfUnchanged: (target, expectedContents) => invoke('removeIfUnchanged', {
      target,
      expectedText: typeof expectedContents === 'string' ? expectedContents : null,
      expectedSha256: typeof expectedContents === 'string' ? null : expectedContents?.sha256 ?? null,
    }),
  });
}
