/* global process */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const STATUSES = new Set(['queued', 'running', 'succeeded', 'failed']);
const IMAGE_TYPES = new Set(['image/avif', 'image/bmp', 'image/gif', 'image/jpeg', 'image/png', 'image/webp']);
const ERROR_CODES = new Set(['provider_unavailable', 'provider_rejected', 'invalid_provider_result']);
const ACTIVE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1000;
const RESULT_RETENTION_MS = 24 * 60 * 60 * 1000;
const CONFIRMATION_RETENTION_MS = 60 * 60 * 1000;
const CREDENTIAL_SHAPED_TASK_ID = /^(?:sk|pk|rk|api(?:[_-]?key)?|bearer|token|secret)[_-]/i;
const JWT_SHAPED_TASK_ID = /(?:^|[-_:])(?:[A-Za-z0-9_-]+\.){2}[A-Za-z0-9_-]+(?:$|[-_:])/;
const UUID_TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_TASK_ID = /^[0-9a-f]{16,64}$/i;
const ULID_TASK_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
const PREFIXED_TASK_ID = /^(?:job|task|image|generation|request|provider|upstream)[_.:-](.+)$/i;

function isKnownOpaqueTaskId(value) {
  if (UUID_TASK_ID.test(value) || HEX_TASK_ID.test(value) || ULID_TASK_ID.test(value)) return true;
  const match = value.match(PREFIXED_TASK_ID);
  return Boolean(match && (UUID_TASK_ID.test(match[1]) || HEX_TASK_ID.test(match[1]) || ULID_TASK_ID.test(match[1])));
}

function timestamp(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function providerHttpStatus(value) {
  return Number.isInteger(value) && value >= 300 && value <= 599 ? value : null;
}

export function isSafeUpstreamTaskId(value) {
  return typeof value === 'string'
    && isKnownOpaqueTaskId(value)
    && !CREDENTIAL_SHAPED_TASK_ID.test(value)
    && !JWT_SHAPED_TASK_ID.test(value);
}

function safeTask(value) {
  if (!value || typeof value !== 'object'
    || typeof value.id !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(value.id)
    || value.provider !== 'ai-media'
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
  if (isSafeUpstreamTaskId(value.upstreamTaskId)) {
    task.upstreamTaskId = value.upstreamTaskId;
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
  return task;
}

function loadTasks(file) {
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed.map(safeTask).filter(Boolean) : [];
  } catch {
    return [];
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
}) {
  const tasks = new Map(loadTasks(file).map((task) => [task.id, task]));
  const activeRetention = duration(activeRetentionMs, ACTIVE_RETENTION_MS);
  const terminalRetention = duration(terminalRetentionMs, TERMINAL_RETENTION_MS);
  const resultRetention = duration(resultRetentionMs, RESULT_RETENTION_MS);
  const confirmationRetention = duration(confirmationRetentionMs, CONFIRMATION_RETENTION_MS);

  return {
    tasks,
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
        if (task.bytes) {
          const availableAt = task.resultAvailableAt ?? terminalAt;
          const resultExpiresAt = task.resultConfirmedAt
            ? Math.min(task.resultConfirmedAt + confirmationRetention, availableAt + resultRetention)
            : availableAt + resultRetention;
          if (resultExpiresAt <= currentTime) {
            delete task.bytes;
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
        const temporaryFile = `${file}.${process.pid}.tmp`;
        writeFileSync(temporaryFile, JSON.stringify(persisted), 'utf8');
        renameSync(temporaryFile, file);
      } catch {
        // Ephemeral task recovery remains best effort.
      }
    },
  };
}
