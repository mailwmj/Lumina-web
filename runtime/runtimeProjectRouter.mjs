import { Readable } from 'node:stream';

import {
  MAX_ASSET_METADATA_BYTES,
  MAX_DURABLE_ASSET_BYTES,
  MAX_HISTORY_DOCUMENT_BYTES,
  MAX_PROJECT_DOCUMENT_BYTES,
  decoder,
  encoder,
  parseJsonText,
} from './fileProjectLibrary/core.mjs';

const MAX_JSON_BODY_BYTES = (MAX_PROJECT_DOCUMENT_BYTES * 6)
  + (MAX_HISTORY_DOCUMENT_BYTES * 2)
  + MAX_ASSET_METADATA_BYTES;

export function createRuntimeProjectRouter(options) {
  const projectService = options?.projectService;
  const canonicalOrigin = parseCanonicalOrigin(options?.canonicalOrigin);
  if (!projectService || typeof projectService.createBrowserSession !== 'function') {
    throw new TypeError('The Runtime project router requires a project service.');
  }
  const canonicalHost = new URL(canonicalOrigin).host;

  return async function routeRuntimeProjectRequest(request, response) {
    applyNoStore(response);
    try {
      authorizeTransport(request, canonicalOrigin, canonicalHost);
      const url = new URL(request.url ?? '/', canonicalOrigin);

      if (request.method === 'POST' && url.pathname === '/api/runtime/session') {
        assertExactRecord(await readJson(request, 1024), [], 'session request');
        const session = projectService.createBrowserSession();
        sendJson(response, 201, session);
        return;
      }

      const session = requireSessionToken(readBearerSession(request));
      if (request.method === 'DELETE' && url.pathname === '/api/runtime/session') {
        projectService.closeBrowserSession(session);
        response.writeHead(204).end();
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/runtime/editor') {
        sendJson(response, 200, projectService.getEditorStatus(session));
      } else if (request.method === 'POST' && url.pathname === '/api/runtime/editor/acquire') {
        assertExactRecord(await readJson(request, 1024), [], 'lease request');
        sendJson(response, 200, projectService.acquireChromeLease(session));
      } else if (request.method === 'POST' && url.pathname === '/api/runtime/editor/renew') {
        const body = assertExactRecord(await readJson(request, 1024), ['leaseToken'], 'lease renewal');
        sendJson(response, 200, projectService.renewChromeLease(session, requiredString(body.leaseToken, 'leaseToken')));
      } else if (request.method === 'POST' && url.pathname === '/api/runtime/editor/release') {
        const body = assertExactRecord(await readJson(request, 1024), ['leaseToken'], 'lease release');
        projectService.releaseChromeLease(session, requiredString(body.leaseToken, 'leaseToken'));
        response.writeHead(204).end();
      } else if (request.method === 'POST' && url.pathname === '/api/runtime/editor/handoff') {
        const body = assertExactRecord(
          await readJson(request, 2048),
          ['leaseToken', 'codexSessionId'],
          'Codex handoff',
        );
        sendJson(response, 200, projectService.handoffToCodex(
          session,
          requiredString(body.leaseToken, 'leaseToken'),
          requiredString(body.codexSessionId, 'codexSessionId'),
        ));
      } else if (request.method === 'POST' && url.pathname === '/api/runtime/editor/handoff-abort') {
        const body = assertExactRecord(
          await readJson(request, 2048),
          ['codexSessionId'],
          'Codex handoff abort',
        );
        projectService.abortCodexHandoff(
          session,
          requiredString(body.codexSessionId, 'codexSessionId'),
        );
        response.writeHead(204).end();
      } else if (request.method === 'GET' && url.pathname === '/api/runtime/projects') {
        sendJson(response, 200, { projects: await projectService.listProjects(session) });
      } else if (request.method === 'POST' && url.pathname === '/api/runtime/project/open') {
        const body = assertExactRecord(await readJson(request, 2048), ['projectId'], 'project open');
        const project = await projectService.openProject(session, requiredString(body.projectId, 'projectId'));
        sendJson(response, 200, { project });
      } else if (request.method === 'PUT' && url.pathname === '/api/runtime/project') {
        const record = await readJson(request, MAX_JSON_BODY_BYTES);
        sendJson(response, 200, { project: await projectService.saveSnapshot(readAuthority(request, session), record) });
      } else if (request.method === 'PATCH' && url.pathname === '/api/runtime/project/viewport') {
        const body = assertExactRecord(
          await readJson(request, (MAX_PROJECT_DOCUMENT_BYTES * 2) + 4096),
          ['projectId', 'viewportJson'],
          'viewport update',
        );
        const project = await projectService.updateViewport(
          readAuthority(request, session),
          requiredString(body.projectId, 'projectId'),
          requiredString(body.viewportJson, 'viewportJson'),
        );
        sendJson(response, 200, { project });
      } else if (request.method === 'PATCH' && url.pathname === '/api/runtime/project/name') {
        const body = assertExactRecord(
          await readJson(request, 4096),
          ['projectId', 'name', 'updatedAt'],
          'project rename',
        );
        const project = await projectService.renameProject(
          readAuthority(request, session),
          requiredString(body.projectId, 'projectId'),
          requiredString(body.name, 'name'),
          requiredNonNegativeInteger(body.updatedAt, 'updatedAt'),
        );
        sendJson(response, 200, { project });
      } else if (request.method === 'DELETE' && url.pathname === '/api/runtime/project') {
        const body = assertExactRecord(await readJson(request, 2048), ['projectId'], 'project deletion');
        const deleted = await projectService.deleteProject(
          readAuthority(request, session),
          requiredString(body.projectId, 'projectId'),
        );
        sendJson(response, 200, { deleted });
      } else if (request.method === 'GET' && url.pathname === '/api/runtime/asset/metadata') {
        const metadata = await projectService.getAssetMetadata(session, requiredQuery(url, 'assetId'));
        sendJson(response, 200, { metadata });
      } else if (request.method === 'GET' && url.pathname === '/api/runtime/asset') {
        const blob = await projectService.readAsset(session, requiredQuery(url, 'assetId'));
        if (!blob) {
          response.writeHead(404).end();
          return;
        }
        response.writeHead(200, {
          'Content-Length': String(blob.size),
          'Content-Type': blob.type,
        });
        Readable.fromWeb(blob.stream()).pipe(response);
      } else if (request.method === 'PUT' && url.pathname === '/api/runtime/asset') {
        const metadata = readAssetMetadata(request);
        const size = readAssetContentLength(request);
        const contentType = String(request.headers['content-type'] ?? '').trim().toLowerCase();
        if (contentType !== metadata.mimeType || request.headers['content-encoding'] !== undefined) {
          throw requestError('unsupported_media_type', 'The asset media type is invalid.');
        }
        const blob = {
          size,
          type: metadata.mimeType,
          stream: () => Readable.toWeb(request),
        };
        const stored = await projectService.writeAsset(readAuthority(request, session), {
          ...metadata,
          blob,
        });
        sendJson(response, 201, { metadata: stored });
      } else if (request.method === 'DELETE' && url.pathname === '/api/runtime/asset') {
        const body = assertExactRecord(await readJson(request, 2048), ['assetId'], 'asset deletion');
        const deleted = await projectService.deleteAsset(
          readAuthority(request, session),
          requiredString(body.assetId, 'assetId'),
        );
        sendJson(response, 200, { deleted });
      } else {
        sendError(response, 404, 'not_found', 'Runtime project route not found.');
      }
    } catch (error) {
      sendMappedError(response, error);
    }
  };
}

function authorizeTransport(request, canonicalOrigin, canonicalHost) {
  if (request.headers.host !== canonicalHost) {
    throw requestError('origin_not_allowed', 'The request host is not allowed.');
  }
  if (request.method !== 'GET' && request.method !== 'HEAD' && request.headers.origin !== canonicalOrigin) {
    throw requestError('origin_not_allowed', 'The request Origin is not allowed.');
  }
  if (request.headers.origin !== undefined && request.headers.origin !== canonicalOrigin) {
    throw requestError('origin_not_allowed', 'The request Origin is not allowed.');
  }
}

function readBearerSession(request) {
  const authorization = singleHeader(request, 'authorization');
  if (!authorization?.startsWith('Bearer ')) return null;
  const token = authorization.slice('Bearer '.length);
  return token.length > 0 ? token : null;
}

function requireSessionToken(value) {
  if (!value) throw requestError('session_invalid', 'The Runtime browser session is invalid.');
  return value;
}

function readAuthority(request, sessionToken) {
  const delegationToken = singleHeader(request, 'x-lumina-codex-delegation');
  const actionId = singleHeader(request, 'x-lumina-codex-action');
  const leaseToken = singleHeader(request, 'x-lumina-editor-lease');
  if (delegationToken || actionId) {
    if (!delegationToken || !actionId || leaseToken) {
      throw requestError('editor_lease_invalid', 'The Runtime editing authority is invalid.');
    }
    return { delegationToken, actionId };
  }
  if (!leaseToken) throw requestError('editor_lease_invalid', 'The Runtime editing authority is invalid.');
  return { sessionToken, leaseToken };
}

function singleHeader(request, name) {
  const value = request.headers[name];
  if (Array.isArray(value)) throw requestError('invalid_request', 'A Runtime request header is invalid.');
  return typeof value === 'string' && value.length > 0 ? value : null;
}

async function readJson(request, limit) {
  const contentType = String(request.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw requestError('unsupported_media_type', 'The Runtime request must contain JSON.');
  }
  const declaredLength = singleHeader(request, 'content-length');
  if (declaredLength !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(declaredLength)) {
      throw requestError('invalid_request', 'The Runtime Content-Length is invalid.');
    }
    if (Number(declaredLength) > limit) {
      request.resume();
      throw requestError('request_too_large', 'The Runtime request is too large.');
    }
  }
  const chunks = [];
  let byteCount = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteCount += bytes.byteLength;
    if (byteCount > limit) throw requestError('request_too_large', 'The Runtime request is too large.');
    chunks.push(bytes);
  }
  try {
    const text = decoder.decode(Buffer.concat(chunks));
    return parseJsonText(text);
  } catch {
    throw requestError('invalid_request', 'The Runtime request JSON is invalid.');
  }
}

function readAssetMetadata(request) {
  const encoded = singleHeader(request, 'x-lumina-asset-metadata');
  if (!encoded || encoded.length > Math.ceil(MAX_ASSET_METADATA_BYTES * 4 / 3) || !/^[A-Za-z0-9_-]+$/u.test(encoded)) {
    throw requestError('invalid_asset', 'Asset metadata is invalid.');
  }
  try {
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.byteLength > MAX_ASSET_METADATA_BYTES) throw new Error();
    const metadata = parseJsonText(decoder.decode(bytes));
    assertExactRecord(metadata, [
      'assetId', 'projectId', 'kind', 'sourceKind', 'mimeType', 'createdAt',
      'width', 'height', 'durationMs', 'sourceMetadata',
    ], 'asset metadata');
    return metadata;
  } catch (error) {
    if (error?.runtimeRequestError) throw error;
    throw requestError('invalid_asset', 'Asset metadata is invalid.');
  }
}

function readAssetContentLength(request) {
  const value = singleHeader(request, 'content-length');
  if (!value || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw requestError('invalid_asset', 'Asset Content-Length is required.');
  }
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size > MAX_DURABLE_ASSET_BYTES) {
    throw requestError('asset_too_large', 'Asset bytes exceed the Runtime limit.');
  }
  return size;
}

function assertExactRecord(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw requestError('invalid_request', `${label} is invalid.`);
  }
  const keys = Object.keys(value);
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) {
    throw requestError('invalid_request', `${label} fields are invalid.`);
  }
  return value;
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw requestError('invalid_request', `${field} is invalid.`);
  }
  return value;
}

function requiredNonNegativeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw requestError('invalid_request', `${field} is invalid.`);
  }
  return value;
}

function requiredQuery(url, name) {
  if (url.searchParams.size !== 1 || !url.searchParams.has(name)) {
    throw requestError('invalid_request', `${name} is invalid.`);
  }
  return requiredString(url.searchParams.get(name), name);
}

function parseCanonicalOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:'
      || url.hostname !== '127.0.0.1'
      || !url.port
      || url.username
      || url.password
      || url.pathname !== '/'
      || url.search
      || url.hash) throw new Error();
    return url.origin;
  } catch {
    throw new TypeError('The Runtime project router requires a canonical loopback Origin.');
  }
}

function requestError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.runtimeRequestError = true;
  return error;
}

function sendMappedError(response, error) {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const code = typeof error?.code === 'string' ? error.code : 'runtime_error';
  const status = errorStatus(code);
  const safeCode = status === 500 ? 'runtime_error' : code;
  const message = safeMessage(safeCode);
  sendError(response, status, safeCode, message);
}

function errorStatus(code) {
  if (code === 'origin_not_allowed') return 403;
  if (code === 'session_invalid') return 401;
  if (code === 'not_found') return 404;
  if (code === 'request_too_large' || code === 'asset_too_large') return 413;
  if (code === 'unsupported_media_type') return 415;
  if (['editor_busy', 'editor_lease_invalid', 'asset_exists', 'asset_still_referenced'].includes(code)) return 409;
  if (code === 'runtime_unavailable') return 503;
  if (errorIsClientFault(code)) return 400;
  return 500;
}

function errorIsClientFault(code) {
  return code.startsWith('invalid_')
    || code.startsWith('project_secret_')
    || ['session_exists', 'session_limit_reached', 'asset_owner_missing',
      'asset_reference_missing', 'asset_metadata_too_large'].includes(code);
}

function safeMessage(code) {
  const messages = {
    origin_not_allowed: 'The request Origin is not allowed.',
    session_invalid: 'The Runtime browser session is invalid or expired.',
    session_exists: 'A Runtime browser session is already active.',
    session_limit_reached: 'The Runtime has too many active browser sessions.',
    editor_busy: 'Another editor owns the Runtime editing lease.',
    editor_lease_invalid: 'The Runtime editing lease is invalid or expired.',
    request_too_large: 'The Runtime request is too large.',
    asset_too_large: 'Asset bytes exceed the Runtime limit.',
    unsupported_media_type: 'The Runtime media type is unsupported.',
    not_found: 'Runtime project route not found.',
    runtime_unavailable: 'The Runtime project service is unavailable.',
    runtime_error: 'The Runtime project operation failed.',
  };
  return messages[code] ?? 'The Runtime project request is invalid.';
}

function applyNoStore(response) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Pragma', 'no-cache');
}

function sendError(response, status, code, message) {
  sendJson(response, status, { error: code, message });
}

function sendJson(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(encoder.encode(JSON.stringify(value)));
}
