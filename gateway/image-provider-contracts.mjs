/* global Buffer, URL */

const AI_MEDIA_PROVIDER_ID = 'ai-media';
const CHAOMO_PROVIDER_ID = 'chaomo';
const CUSTOM_OPENAI_PROVIDER_PREFIX = 'custom-openai:';
const BOUNDED_OPAQUE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const AI_MEDIA_TASK_ID = /^imgtask_[A-Za-z0-9][A-Za-z0-9._:-]{15,119}$/;
const SENSITIVE_SHAPED_TASK_ID = /(?:^|[_.:-])(?:sk|pk|rk|api(?:[_-]?key)?|bearer|token|secret|prompt)[_.:-]/i;
const SENSITIVE_DECODED_TASK_ID = /(?:bearer|secret|token|api[_ -]?key|prompt)/i;
const JWT_SHAPED_TASK_ID = /(?:^|[-_:])(?:[A-Za-z0-9_-]+\.){2}[A-Za-z0-9_-]+(?:$|[-_:])/;
const DIAGNOSTIC_FIELDS = new Set([
  'assets', 'data', 'id', 'object', 'output', 'poll_after_ms', 'poll_url', 'request_id',
  'requestId', 'response', 'result', 'result_url', 'status', 'status_url', 'task_id', 'taskId',
]);
const NESTED_DIAGNOSTIC_CONTAINERS = new Set(['data', 'response', 'result']);

const PROVIDER_CONTRACTS = {
  [AI_MEDIA_PROVIDER_ID]: {
    candidateFields: ['task_id', 'id'],
    recordPaths: [[]],
    pollFields: ['status_url', 'poll_url'],
  },
  [CHAOMO_PROVIDER_ID]: {
    candidateFields: ['task_id'],
    recordPaths: [[]],
    pollFields: [],
  },
};

const CUSTOM_OPENAI_CONTRACT = {
  candidateFields: ['task_id', 'taskId', 'id', 'request_id', 'requestId'],
  recordPaths: [[], ['data']],
  pollFields: ['status_url', 'poll_url'],
};

function providerCategory(providerId) {
  return typeof providerId === 'string' && providerId.startsWith(CUSTOM_OPENAI_PROVIDER_PREFIX)
    ? 'custom-openai'
    : providerId;
}

function providerContract(providerId) {
  if (typeof providerId === 'string' && providerId.startsWith(CUSTOM_OPENAI_PROVIDER_PREFIX)) {
    return CUSTOM_OPENAI_CONTRACT;
  }
  return PROVIDER_CONTRACTS[providerId] ?? CUSTOM_OPENAI_CONTRACT;
}

function containsEncodedSensitiveTaskId(value) {
  return value.split(/[_.:-]+/).some((segment) => {
    if (segment.length < 16 || !/^[A-Za-z0-9_-]+$/.test(segment)) return false;
    try {
      const decoded = Buffer.from(segment, 'base64url');
      if (decoded.toString('base64url') !== segment.replace(/=+$/, '')) return false;
      return SENSITIVE_DECODED_TASK_ID.test(decoded.toString('utf8'));
    } catch {
      return false;
    }
  });
}

export function isSafeImageProviderTaskId(providerId, value) {
  if (typeof value !== 'string' || !BOUNDED_OPAQUE_TASK_ID.test(value)) return false;
  if (providerId === AI_MEDIA_PROVIDER_ID && /^imgtask_/i.test(value) && !AI_MEDIA_TASK_ID.test(value)) {
    return false;
  }
  return !SENSITIVE_SHAPED_TASK_ID.test(value)
    && !JWT_SHAPED_TASK_ID.test(value)
    && !containsEncodedSensitiveTaskId(value);
}

function recordAt(payload, path) {
  let record = payload;
  for (const segment of path) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
    record = record[segment];
  }
  return record && typeof record === 'object' && !Array.isArray(record) ? record : null;
}

function safeProviderPollPath(candidate, baseUrl) {
  if (typeof candidate !== 'string' || !candidate.trim()) return null;
  try {
    const base = new URL(baseUrl);
    const target = new URL(candidate, base);
    const basePath = base.pathname.replace(/\/+$/, '');
    if (target.origin !== base.origin || target.username || target.password || target.hash
      || !target.pathname.startsWith(`${basePath}/`)
      || target.toString().length > 2048
      || [...target.searchParams.keys()].some((name) => /token|secret|key|sign|auth/i.test(name))) {
      return null;
    }
    return `${target.pathname.slice(basePath.length)}${target.search}`;
  } catch {
    return null;
  }
}

function diagnosticFieldNames(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { topLevelFields: [], nestedFields: [] };
  }
  const topLevelFields = Object.keys(payload)
    .filter((field) => DIAGNOSTIC_FIELDS.has(field))
    .sort();
  const nestedFields = [];
  for (const container of [...NESTED_DIAGNOSTIC_CONTAINERS].sort()) {
    const value = payload[container];
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    nestedFields.push(...Object.keys(value)
      .filter((field) => DIAGNOSTIC_FIELDS.has(field))
      .sort()
      .map((field) => `${container}.${field}`));
  }
  return { topLevelFields, nestedFields };
}

function idPrefixCategory(value) {
  if (!value) return 'none';
  if (/^imgtask_/i.test(value)) return 'imgtask';
  if (/^chaomo[-_.:]task[-_.:]/i.test(value)) return 'chaomo-task';
  if (/^task[-_.:]/i.test(value)) return 'task';
  return 'other';
}

function idCharacterCategory(value) {
  if (!value) return 'none';
  if (/^[A-Za-z0-9]+$/.test(value)) return 'alphanumeric';
  if (BOUNDED_OPAQUE_TASK_ID.test(value)) return 'opaque-safe';
  return 'unsafe';
}

function receiptDiagnostic(providerId, payload, candidate) {
  return {
    provider: providerCategory(providerId),
    ...diagnosticFieldNames(payload),
    candidateField: candidate?.field ?? 'none',
    candidateIdLength: candidate?.value.length ?? 0,
    candidateIdPrefix: idPrefixCategory(candidate?.value),
    candidateIdCharacters: idCharacterCategory(candidate?.value),
  };
}

export function parseImageProviderSubmitReceipt(providerId, payload, baseUrl) {
  const contract = providerContract(providerId);
  let firstCandidate = null;
  let selectedCandidate = null;
  let selectedRecord = null;

  for (const path of contract.recordPaths) {
    const record = recordAt(payload, path);
    if (!record) continue;
    for (const field of contract.candidateFields) {
      const value = typeof record[field] === 'string' ? record[field].trim() : '';
      if (!value) continue;
      firstCandidate ??= { field, value };
      if (isSafeImageProviderTaskId(providerId, value)) {
        selectedCandidate = { field, value };
        selectedRecord = record;
        break;
      }
    }
    if (selectedCandidate) break;
  }

  const pollPath = selectedCandidate && selectedRecord
    ? contract.pollFields
      .map((field) => selectedRecord[field])
      .map((value) => safeProviderPollPath(value, baseUrl))
      .find(Boolean) ?? null
    : null;

  return {
    taskId: selectedCandidate?.value ?? null,
    pollPath,
    diagnostic: receiptDiagnostic(providerId, payload, selectedCandidate ?? firstCandidate),
  };
}
