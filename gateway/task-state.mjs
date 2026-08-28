/* global Buffer, URL, process */

import {
  closeSync,
  createReadStream,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';

import { isSafeImageProviderTaskId } from './image-provider-contracts.mjs';

const STATUSES = new Set(['queued', 'running', 'succeeded', 'failed']);
const IMAGE_TYPES = new Set(['image/avif', 'image/bmp', 'image/gif', 'image/jpeg', 'image/png', 'image/webp']);
const ERROR_CODES = new Set(['provider_unavailable', 'provider_rejected', 'invalid_provider_result', 'submission_interrupted']);
const ACTIVE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1000;
const RESULT_RETENTION_MS = 24 * 60 * 60 * 1000;
const CONFIRMATION_RETENTION_MS = 60 * 60 * 1000;
const MAX_RESULT_BYTES = 50 * 1024 * 1024;
const RESULT_FILE_NAME = /^(job-[A-Za-z0-9-]{1,124})\.result$/;
const RESULT_RECOVERY_FILE_NAME = /^(job-[A-Za-z0-9-]{1,124})\.result\.recovery$/;
const RESULT_RECOVERY_MAGIC = Buffer.from('LUMINA_RESULT_RECOVERY_V1\n', 'ascii');
const MAX_RESULT_RECOVERY_HEADER_BYTES = 8 * 1024;
const CUSTOM_OPENAI_PROVIDER_ID = /^custom-openai:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function timestamp(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function providerHttpStatus(value) {
  return Number.isInteger(value) && value >= 300 && value <= 599 ? value : null;
}

function recoverySnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !Number.isInteger(value.retry_count) || value.retry_count < 1 || value.retry_count > 5
    || typeof value.requires_manual_requery !== 'boolean') {
    return null;
  }
  const nextRetryAt = timestamp(value.next_retry_at);
  if (!value.requires_manual_requery && nextRetryAt === null) return null;
  return {
    retry_count: value.retry_count,
    ...(nextRetryAt === null ? {} : { next_retry_at: nextRetryAt }),
    requires_manual_requery: value.requires_manual_requery,
    ...(typeof value.last_error === 'string' && value.last_error.length <= 512
      ? { last_error: value.last_error }
      : {}),
  };
}

export function isSafeUpstreamTaskId(value) {
  return isSafeImageProviderTaskId('custom-openai:compatibility', value);
}

function safeUpstreamPollPath(value) {
  const hasControlCharacter = typeof value === 'string' && Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
  if (typeof value !== 'string' || value.length < 1 || value.length > 2048
    || !value.startsWith('/') || value.startsWith('//') || hasControlCharacter || value.includes('#')) {
    return null;
  }
  try {
    const parsed = new URL(value, 'https://lumina.invalid');
    if (parsed.origin !== 'https://lumina.invalid' || `${parsed.pathname}${parsed.search}` !== value
      || [...parsed.searchParams.keys()].some((name) => /token|secret|key|sign|auth/i.test(name))) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

function safeTask(value) {
  if (!value || typeof value !== 'object'
    || typeof value.id !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(value.id)
    || typeof value.provider !== 'string'
    || (!['ai-media', 'chaomo'].includes(value.provider) && !CUSTOM_OPENAI_PROVIDER_ID.test(value.provider))
    || !STATUSES.has(value.status)
    || typeof value.sourceId !== 'string' || !/^[a-f0-9]{64}$/.test(value.sourceId)
    || typeof value.sessionBinding !== 'string' || !/^[a-f0-9]{64}$/.test(value.sessionBinding)
    || timestamp(value.createdAt) === null || timestamp(value.updatedAt) === null) {
    return null;
  }
  const task = {
    id: value.id,
    provider: value.provider,
    status: value.status,
    sourceId: value.sourceId,
    sessionBinding: value.sessionBinding,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
  if (isSafeImageProviderTaskId(value.provider, value.upstreamTaskId)) {
    task.upstreamTaskId = value.upstreamTaskId;
    const pollPath = safeUpstreamPollPath(value.upstreamPollPath);
    if (pollPath) task.upstreamPollPath = pollPath;
  }
  for (const name of ['terminalAt', 'resultAvailableAt', 'resultConfirmedAt']) {
    if (timestamp(value[name]) !== null) task[name] = value[name];
  }
  if (typeof value.contentType === 'string' && IMAGE_TYPES.has(value.contentType)) {
    task.contentType = value.contentType;
  }
  if (typeof value.errorCode === 'string' && ERROR_CODES.has(value.errorCode)) {
    task.errorCode = value.errorCode;
  }
  if (task.errorCode === 'provider_rejected' && providerHttpStatus(value.providerHttpStatus) !== null) {
    task.providerHttpStatus = value.providerHttpStatus;
  }
  const recovery = recoverySnapshot(value.recovery);
  if (recovery && (task.status === 'queued' || task.status === 'running')) task.recovery = recovery;
  return task;
}

function resultFilePath(directory, taskId) {
  return join(directory, `${taskId}.result`);
}

function resultRecoveryPath(directory, taskId) {
  return join(directory, `${taskId}.result.recovery`);
}

function readRawResult(path, maximumBytes, expectedSha256 = null) {
  let descriptor;
  try {
    const stats = statSync(path);
    if (!stats.isFile() || stats.size < 1 || stats.size > maximumBytes) return null;
    descriptor = { offset: 0, path, size: stats.size };
    if (expectedSha256 && hashResultRange(descriptor) !== expectedSha256) return null;
    return descriptor;
  } catch {
    return null;
  }
}

function hashResultRange({ offset, path, size }) {
  let descriptor;
  try {
    descriptor = openSync(path, 'r');
    const hash = createHash('sha256');
    const chunk = Buffer.allocUnsafe(Math.min(size, 64 * 1024));
    let consumed = 0;
    while (consumed < size) {
      const length = readSync(
        descriptor,
        chunk,
        0,
        Math.min(chunk.length, size - consumed),
        offset + consumed,
      );
      if (length < 1) return null;
      hash.update(chunk.subarray(0, length));
      consumed += length;
    }
    return hash.digest('hex');
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readRecoverySpool(path, maximumBytes) {
  let descriptor;
  try {
    const stats = statSync(path);
    if (!stats.isFile()
      || stats.size < RESULT_RECOVERY_MAGIC.length + 4
      || stats.size > maximumBytes + RESULT_RECOVERY_MAGIC.length + MAX_RESULT_RECOVERY_HEADER_BYTES + 16) {
      return null;
    }
    descriptor = openSync(path, 'r');
    const probe = Buffer.allocUnsafe(Math.min(
      stats.size,
      RESULT_RECOVERY_MAGIC.length + MAX_RESULT_RECOVERY_HEADER_BYTES + 16,
    ));
    const probeLength = readSync(descriptor, probe, 0, probe.length, 0);
    const content = probe.subarray(0, probeLength);
    if (!content.subarray(0, RESULT_RECOVERY_MAGIC.length).equals(RESULT_RECOVERY_MAGIC)) return null;
    const lengthEnd = content.indexOf(0x0a, RESULT_RECOVERY_MAGIC.length);
    if (lengthEnd < 0) return null;
    const headerLengthText = content.subarray(RESULT_RECOVERY_MAGIC.length, lengthEnd).toString('ascii');
    if (!/^[1-9][0-9]{0,4}$/.test(headerLengthText)) return null;
    const headerLength = Number(headerLengthText);
    if (headerLength > MAX_RESULT_RECOVERY_HEADER_BYTES) return null;
    const headerStart = lengthEnd + 1;
    const payloadOffset = headerStart + headerLength;
    if (payloadOffset > probeLength) return null;
    const header = JSON.parse(content.subarray(headerStart, payloadOffset).toString('utf8'));
    const task = safeTask(header?.task);
    if (!task || task.status !== 'succeeded' || !task.contentType
      || !Number.isSafeInteger(header?.byteLength) || header.byteLength < 1 || header.byteLength > maximumBytes
      || typeof header.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(header.sha256)
      || stats.size !== payloadOffset + header.byteLength) {
      return null;
    }
    const spool = {
      contentType: task.contentType,
      offset: payloadOffset,
      path,
      sha256: header.sha256,
      size: header.byteLength,
      task,
    };
    return hashResultRange(spool) === header.sha256 ? spool : null;
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function sameTaskIdentity(left, right) {
  return left?.id === right?.id
    && left?.provider === right?.provider
    && left?.sourceId === right?.sourceId
    && left?.sessionBinding === right?.sessionBinding
    && left?.createdAt === right?.createdAt;
}

function reconcileResultSpools(tasks, directory, maximumBytes) {
  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  const retainedResultFiles = new Set();
  const retainedRecoveryFiles = new Set();
  if (existsSync(directory)) {
    for (const name of readdirSync(directory).filter((entry) => RESULT_RECOVERY_FILE_NAME.test(entry))) {
      const taskId = name.match(RESULT_RECOVERY_FILE_NAME)[1];
      const existingTask = taskMap.get(taskId);
      const spool = readRecoverySpool(join(directory, name), maximumBytes);
      const activeRecovery = spool && sameTaskIdentity(existingTask, spool.task)
        && (existingTask?.status === 'queued' || existingTask?.status === 'running');
      const succeededRecovery = spool && sameTaskIdentity(existingTask, spool.task)
        && existingTask?.status === 'succeeded'
        && existingTask.contentType === spool.contentType;
      if (activeRecovery || succeededRecovery) {
        if (activeRecovery) taskMap.set(taskId, spool.task);
        retainedRecoveryFiles.add(name);
        const rawName = `${taskId}.result`;
        if (readRawResult(join(directory, rawName), maximumBytes, spool.sha256)) {
          retainedResultFiles.add(rawName);
        }
      } else {
        try { unlinkSync(join(directory, name)); } catch { /* cleanup is best effort */ }
      }
    }
    for (const name of readdirSync(directory).filter((entry) => RESULT_FILE_NAME.test(entry))) {
      if (retainedResultFiles.has(name)) continue;
      const taskId = name.match(RESULT_FILE_NAME)[1];
      const existingTask = taskMap.get(taskId);
      if (retainedRecoveryFiles.has(`${taskId}.result.recovery`)) {
        try { unlinkSync(join(directory, name)); } catch { /* cleanup is best effort */ }
      } else if (existingTask?.status === 'succeeded'
        && existingTask.contentType
        && readRawResult(join(directory, name), maximumBytes)) {
        retainedResultFiles.add(name);
      } else {
        try { unlinkSync(join(directory, name)); } catch { /* cleanup is best effort */ }
      }
    }
  }
  for (const [taskId, task] of taskMap) {
    if (task.status !== 'succeeded'
      || retainedResultFiles.has(`${taskId}.result`)
      || retainedRecoveryFiles.has(`${taskId}.result.recovery`)) continue;
    if (task.upstreamTaskId) {
      task.status = 'running';
      delete task.terminalAt;
      delete task.resultAvailableAt;
      delete task.resultConfirmedAt;
      delete task.contentType;
    } else {
      task.status = 'failed';
      task.errorCode = 'invalid_provider_result';
      task.terminalAt = task.updatedAt;
      delete task.contentType;
      delete task.resultAvailableAt;
      delete task.resultConfirmedAt;
    }
  }
  return [...taskMap.values()];
}

function loadTasks(file, directory, maximumBytes) {
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const tasks = Array.isArray(parsed) ? parsed.map(safeTask).filter(Boolean) : [];
    return reconcileResultSpools(tasks, directory, maximumBytes);
  } catch {
    return [];
  }
}

function writeAll(file, bytes) {
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(file, bytes, offset, bytes.length - offset);
}

function writeAtomically(path, chunks) {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  let output;
  try {
    output = openSync(temporaryPath, 'w', 0o600);
    for (const chunk of chunks) writeAll(output, chunk);
    fsyncSync(output);
    closeSync(output);
    output = undefined;
    renameSync(temporaryPath, path);
  } catch (error) {
    if (output !== undefined) {
      try { closeSync(output); } catch { /* cleanup is best effort */ }
    }
    try { unlinkSync(temporaryPath); } catch { /* cleanup is best effort */ }
    throw error;
  }
}

function writeRecoverySpool(path, task, bytes) {
  const recoveredTask = safeTask(task);
  if (!recoveredTask || recoveredTask.status !== 'succeeded' || !recoveredTask.contentType) {
    throw new Error('invalid result recovery task');
  }
  const header = Buffer.from(JSON.stringify({
    byteLength: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    task: recoveredTask,
  }), 'utf8');
  if (header.length < 1 || header.length > MAX_RESULT_RECOVERY_HEADER_BYTES) {
    throw new Error('result recovery header is too large');
  }
  writeAtomically(path, [
    RESULT_RECOVERY_MAGIC,
    Buffer.from(`${header.length}\n`, 'ascii'),
    header,
    bytes,
  ]);
}

function readResultBytes(source) {
  try {
    const fileBytes = readFileSync(source.path);
    const bytes = fileBytes.subarray(source.offset, source.offset + source.size);
    return bytes.length === source.size ? bytes : null;
  } catch {
    return null;
  }
}

function duration(value, maximum) {
  return Number.isFinite(value) && value >= 1 ? Math.min(value, maximum) : maximum;
}

export function createTaskStateStore({
  file,
  now = Date.now,
  activeRetentionMs = ACTIVE_RETENTION_MS,
  terminalRetentionMs = TERMINAL_RETENTION_MS,
  resultRetentionMs = RESULT_RETENTION_MS,
  confirmationRetentionMs = CONFIRMATION_RETENTION_MS,
  maxResultBytes = MAX_RESULT_BYTES,
}) {
  const resultDirectory = `${file}.results`;
  const maximumResultBytes = duration(maxResultBytes, MAX_RESULT_BYTES);
  const tasks = new Map(loadTasks(file, resultDirectory, maximumResultBytes).map((task) => [task.id, task]));
  const activeRetention = duration(activeRetentionMs, ACTIVE_RETENTION_MS);
  const terminalRetention = duration(terminalRetentionMs, TERMINAL_RETENTION_MS);
  const resultRetention = duration(resultRetentionMs, RESULT_RETENTION_MS);
  const confirmationRetention = duration(confirmationRetentionMs, CONFIRMATION_RETENTION_MS);
  const validRecoveryFile = (taskId) => {
    const task = tasks.get(taskId);
    const recovery = readRecoverySpool(resultRecoveryPath(resultDirectory, taskId), maximumResultBytes);
    return task?.status === 'succeeded' && recovery && sameTaskIdentity(task, recovery.task)
      ? recovery
      : null;
  };
  const validResultSource = (taskId) => {
    const task = tasks.get(taskId);
    if (task?.status !== 'succeeded' || !task.contentType) return null;
    const recovery = validRecoveryFile(taskId);
    if (recovery) {
      return readRawResult(resultFilePath(resultDirectory, taskId), maximumResultBytes, recovery.sha256)
        ?? recovery;
    }
    return readRawResult(resultFilePath(resultDirectory, taskId), maximumResultBytes);
  };

  return {
    tasks,
    hasResult(taskId) {
      const task = tasks.get(taskId);
      return task?.status === 'succeeded' && (
        Boolean(validResultSource(taskId))
        || (Buffer.isBuffer(task.bytes) && task.bytes.length >= 1 && task.bytes.length <= maximumResultBytes)
      );
    },
    readResult(taskId) {
      const task = tasks.get(taskId);
      if (task?.status !== 'succeeded') return null;
      const source = validResultSource(taskId);
      if (!source) {
        return Buffer.isBuffer(task.bytes)
          && task.bytes.length >= 1 && task.bytes.length <= maximumResultBytes
          ? task.bytes
          : null;
      }
      return readResultBytes(source)
        ?? (Buffer.isBuffer(task.bytes)
          && task.bytes.length >= 1 && task.bytes.length <= maximumResultBytes
          ? task.bytes
          : null);
    },
    openResult(taskId, signal) {
      const task = tasks.get(taskId);
      if (task?.status !== 'succeeded') return null;
      const source = validResultSource(taskId);
      if (source) {
        return {
          size: source.size,
          stream: createReadStream(source.path, {
            end: source.offset + source.size - 1,
            signal,
            start: source.offset,
          }),
        };
      }
      if (Buffer.isBuffer(task.bytes)
        && task.bytes.length >= 1 && task.bytes.length <= maximumResultBytes) {
        return { size: task.bytes.length, stream: Readable.from(task.bytes) };
      }
      return null;
    },
    prune(currentTime = now()) {
      let changed = false;
      for (const [taskId, task] of tasks) {
        const terminal = task.status === 'succeeded' || task.status === 'failed';
        const terminalAt = task.terminalAt ?? task.updatedAt;
        if ((!terminal && task.createdAt <= currentTime - activeRetention)
          || (terminal && terminalAt <= currentTime - terminalRetention)) {
          tasks.delete(taskId);
          changed = true;
          continue;
        }
        if (task.status === 'succeeded' && (task.bytes || validResultSource(taskId))) {
          const availableAt = task.resultAvailableAt ?? terminalAt;
          const resultExpiresAt = task.resultConfirmedAt
            ? Math.min(task.resultConfirmedAt + confirmationRetention, availableAt + resultRetention)
            : availableAt + resultRetention;
          if (resultExpiresAt <= currentTime) {
            delete task.bytes;
            try { unlinkSync(resultFilePath(resultDirectory, taskId)); } catch { /* cleanup is best effort */ }
            try { unlinkSync(resultRecoveryPath(resultDirectory, taskId)); } catch { /* cleanup is best effort */ }
            changed = true;
          }
        }
      }
      return changed;
    },
    save() {
      try {
        const persisted = [...tasks.values()].map(safeTask).filter(Boolean);
        mkdirSync(dirname(file), { recursive: true });
        const retainedResultFiles = new Set();
        const resultTasks = persisted.filter((task) => task.status === 'succeeded' && task.contentType);
        if (resultTasks.length > 0) mkdirSync(resultDirectory, { recursive: true });
        for (const task of resultTasks) {
          const liveTask = tasks.get(task.id);
          const resultFile = resultFilePath(resultDirectory, task.id);
          const recoveryFile = resultRecoveryPath(resultDirectory, task.id);
          if (Buffer.isBuffer(liveTask?.bytes)
            && liveTask.bytes.length >= 1 && liveTask.bytes.length <= maximumResultBytes) {
            writeRecoverySpool(recoveryFile, task, liveTask.bytes);
            writeAtomically(resultFile, [liveTask.bytes]);
          } else {
            const recovery = validRecoveryFile(task.id);
            if (recovery
              && !readRawResult(resultFile, maximumResultBytes, recovery.sha256)) {
              const recoveredBytes = readResultBytes(recovery);
              if (!recoveredBytes) throw new Error('result recovery spool is unreadable');
              writeAtomically(resultFile, [recoveredBytes]);
            }
          }
          if (validResultSource(task.id)?.path === resultFile) {
            retainedResultFiles.add(`${task.id}.result`);
            delete liveTask?.bytes;
          }
        }
        writeAtomically(file, [Buffer.from(JSON.stringify(persisted), 'utf8')]);
        if (existsSync(resultDirectory)) {
          for (const name of readdirSync(resultDirectory)) {
            if (RESULT_FILE_NAME.test(name) && !retainedResultFiles.has(name)) {
              try { unlinkSync(join(resultDirectory, name)); } catch { /* cleanup is best effort */ }
            }
            if (RESULT_RECOVERY_FILE_NAME.test(name)) {
              try { unlinkSync(join(resultDirectory, name)); } catch { /* cleanup is best effort */ }
            }
          }
        }
      } catch {
        // Ephemeral task recovery remains best effort.
      }
    },
  };
}
