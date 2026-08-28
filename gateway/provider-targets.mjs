/* global URL */

import { isSafeUpstreamTaskId } from './task-state.mjs';

function normalizedBaseUrl(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) return null;
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol)
      || url.username || url.password || url.search || url.hash) {
      return null;
    }
    url.pathname = url.pathname.replace(/\/+$/, '');
    return url;
  } catch {
    return null;
  }
}

function appendPath(base, suffix, defaultPrefix = '') {
  const target = new URL(base);
  const path = target.pathname.replace(/\/+$/, '');
  target.pathname = path.endsWith(suffix)
    ? path
    : path ? `${path}${suffix}` : `${defaultPrefix}${suffix}`;
  return target;
}

export function textProviderTarget(baseUrl, operation, protocol) {
  const base = normalizedBaseUrl(baseUrl);
  if (!base) return null;
  if (operation === 'models') {
    const path = base.pathname.replace(/\/+$/, '');
    base.pathname = path.endsWith('/models') ? path : path ? `${path}/models` : '/v1/models';
    return base;
  }
  if (operation !== 'request' || !['chat', 'responses'].includes(protocol)) return null;
  if (protocol === 'responses') return appendPath(base, '/responses', '/v1');
  const path = base.pathname.replace(/\/+$/, '');
  base.pathname = path.endsWith('/chat/completions')
    ? path
    : path.endsWith('/api/coding')
      ? `${path}/v3/chat/completions`
      : path ? `${path}/chat/completions` : '/v1/chat/completions';
  return base;
}

export function seedanceProviderTarget(baseUrl, operation, taskId) {
  const base = normalizedBaseUrl(baseUrl);
  if (!base || !['submit', 'poll', 'cancel'].includes(operation)) return null;
  if (operation !== 'submit' && !isSafeUpstreamTaskId(taskId)) return null;
  const path = base.pathname.replace(/\/+$/, '');
  const apiRoot = path.endsWith('/api/v3') ? path : `${path}/api/v3`;
  const taskPath = operation === 'submit' ? '' : `/${encodeURIComponent(taskId)}`;
  base.pathname = `${apiRoot}/contents/generations/tasks${taskPath}`;
  return base;
}

export function providerErrorMessage(payload, fallback) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return fallback;
  const error = payload.error;
  const candidates = [
    error && typeof error === 'object' && !Array.isArray(error) ? error.message : null,
    typeof error === 'string' ? error : null,
    payload.message,
    payload.detail,
    payload.error_message,
  ];
  const message = candidates.find((value) => typeof value === 'string' && value.trim());
  if (!message) return fallback;
  const normalized = message.trim().replace(/\s+/g, ' ').slice(0, 512);
  return /(?:bearer|secret|token|api[_ -]?key|sk-[A-Za-z0-9])/i.test(normalized)
    ? fallback
    : normalized.replace(/https?:\/\/\S+/gi, '<URL>');
}

export function providerRequestId(payload, headers) {
  const values = [
    headers?.get?.('x-request-id'),
    headers?.get?.('request-id'),
    payload && typeof payload === 'object' && !Array.isArray(payload) ? payload.request_id : null,
  ];
  const value = values.find((item) => typeof item === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(item.trim()));
  return value?.trim() ?? null;
}
