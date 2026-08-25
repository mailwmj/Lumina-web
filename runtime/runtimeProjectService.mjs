import { randomBytes } from 'node:crypto';

const DEFAULT_SESSION_TTL_MS = 15 * 60_000;
const DEFAULT_LEASE_TTL_MS = 30_000;
const DEFAULT_DELEGATION_TTL_MS = 10_000;
const MAX_SESSIONS = 64;
const MAX_SESSION_TTL_MS = 24 * 60 * 60_000;
const MAX_AUTHORITY_TTL_MS = 5 * 60_000;

export class RuntimeProjectServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RuntimeProjectServiceError';
    this.code = code;
  }
}

export async function startRuntimeProjectService(options = {}) {
  const service = createRuntimeProjectService(options);
  await service.open();
  return service;
}

export function createRuntimeProjectService(options = {}) {
  const library = options.library;
  if (!isProjectLibrary(library)) {
    throw new RuntimeProjectServiceError(
      'invalid_service',
      'The Runtime project library is unavailable.',
    );
  }

  const now = typeof options.now === 'function' ? options.now : Date.now;
  const createToken = typeof options.createToken === 'function'
    ? options.createToken
    : () => randomBytes(32).toString('base64url');
  const sessionTtlMs = readTtl(
    options.sessionTtlMs,
    DEFAULT_SESSION_TTL_MS,
    MAX_SESSION_TTL_MS,
  );
  const leaseTtlMs = readTtl(options.leaseTtlMs, DEFAULT_LEASE_TTL_MS, MAX_AUTHORITY_TTL_MS);
  const delegationTtlMs = readTtl(
    options.delegationTtlMs,
    DEFAULT_DELEGATION_TTL_MS,
    MAX_AUTHORITY_TTL_MS,
  );
  const sessions = new Map();
  const delegations = new Map();
  let editorLease = null;
  let opened = false;
  let closed = false;

  const service = {
    async open() {
      if (closed) throw unavailable();
      if (!opened) {
        await library.open();
        opened = true;
      }
      return service;
    },

    async close() {
      if (closed) return;
      closed = true;
      editorLease = null;
      sessions.clear();
      delegations.clear();
      if (opened) await library.close();
    },

    createBrowserSession() {
      requireAvailable();
      pruneExpired();
      if (sessions.size >= MAX_SESSIONS) {
        throw new RuntimeProjectServiceError(
          'session_limit_reached',
          'The Runtime has too many active browser sessions.',
        );
      }
      const token = uniqueToken(sessions, createToken);
      const expiresAt = now() + sessionTtlMs;
      sessions.set(token, { expiresAt });
      return { token, expiresAt };
    },

    closeBrowserSession(sessionToken) {
      requireAvailable();
      const session = requireSession(sessionToken);
      sessions.delete(sessionToken);
      if (editorLease?.owner === 'chrome' && editorLease.sessionToken === sessionToken) {
        editorLease = null;
      }
      return Boolean(session);
    },

    getEditorStatus(sessionToken) {
      requireSession(sessionToken);
      expireAuthority();
      if (!editorLease) return { mode: 'available' };
      if (editorLease.owner === 'chrome') {
        return {
          mode: editorLease.sessionToken === sessionToken ? 'chrome' : 'busy',
          expiresAt: editorLease.expiresAt,
        };
      }
      return { mode: 'codex', expiresAt: editorLease.expiresAt };
    },

    acquireChromeLease(sessionToken) {
      requireSession(sessionToken);
      expireAuthority();
      if (editorLease) {
        if (editorLease.owner !== 'chrome' || editorLease.sessionToken !== sessionToken) {
          throw busy();
        }
        editorLease.expiresAt = now() + leaseTtlMs;
        return publicChromeLease(editorLease);
      }
      editorLease = {
        owner: 'chrome',
        sessionToken,
        token: opaqueToken(createToken),
        expiresAt: now() + leaseTtlMs,
      };
      return publicChromeLease(editorLease);
    },

    renewChromeLease(sessionToken, leaseToken) {
      requireSession(sessionToken);
      const lease = requireChromeLease(sessionToken, leaseToken);
      lease.expiresAt = now() + leaseTtlMs;
      return publicChromeLease(lease);
    },

    releaseChromeLease(sessionToken, leaseToken) {
      requireSession(sessionToken);
      requireChromeLease(sessionToken, leaseToken);
      editorLease = null;
      return true;
    },

    handoffToCodex(sessionToken, leaseToken, codexSessionId) {
      requireSession(sessionToken);
      requireOpaqueId(codexSessionId, 'codexSessionId');
      requireChromeLease(sessionToken, leaseToken);
      delegations.clear();
      editorLease = {
        owner: 'codex',
        codexSessionId,
        token: opaqueToken(createToken),
        expiresAt: now() + leaseTtlMs,
      };
      return { mode: 'codex', expiresAt: editorLease.expiresAt };
    },

    abortCodexHandoff(sessionToken, codexSessionId) {
      requireSession(sessionToken);
      requireOpaqueId(codexSessionId, 'codexSessionId');
      expireAuthority();
      if (
        !editorLease
        || editorLease.owner !== 'codex'
        || editorLease.codexSessionId !== codexSessionId
      ) {
        return false;
      }
      editorLease = null;
      delegations.clear();
      return true;
    },

    renewCodexLease(codexSessionId) {
      const lease = requireCodexLease(codexSessionId);
      lease.expiresAt = now() + leaseTtlMs;
      return { mode: 'codex', expiresAt: lease.expiresAt };
    },

    revokeCodexLease(codexSessionId) {
      requireAvailable();
      expireAuthority();
      if (!editorLease) return false;
      if (editorLease.owner !== 'codex' || editorLease.codexSessionId !== codexSessionId) {
        throw leaseInvalid();
      }
      editorLease = null;
      for (const [token, delegation] of delegations) {
        if (delegation.codexSessionId === codexSessionId) delegations.delete(token);
      }
      return true;
    },

    createCodexDelegation(codexSessionId, actionId) {
      const lease = requireCodexLease(codexSessionId);
      requireOpaqueId(actionId, 'actionId');
      const token = uniqueToken(delegations, createToken);
      const expiresAt = Math.min(lease.expiresAt, now() + delegationTtlMs);
      delegations.set(token, { actionId, codexSessionId, expiresAt });
      return { token, actionId, expiresAt };
    },

    async listProjects(sessionToken) {
      requireSession(sessionToken);
      return library.listProjects();
    },

    async openProject(sessionToken, projectId) {
      requireSession(sessionToken);
      return library.openProject(projectId);
    },

    async readAsset(sessionToken, assetId) {
      requireSession(sessionToken);
      return library.readAsset(assetId);
    },

    async getAssetMetadata(sessionToken, assetId) {
      requireSession(sessionToken);
      return library.getAssetMetadata(assetId);
    },

    async saveSnapshot(authority, record) {
      requireMutationAuthority(authority);
      return library.saveSnapshot(record);
    },

    async updateViewport(authority, projectId, viewportJson) {
      requireMutationAuthority(authority);
      return library.updateViewport(projectId, viewportJson);
    },

    async renameProject(authority, projectId, name, updatedAt) {
      requireMutationAuthority(authority);
      return library.renameProject(projectId, name, updatedAt);
    },

    async deleteProject(authority, projectId) {
      requireMutationAuthority(authority);
      return library.deleteProject(projectId);
    },

    async writeAsset(authority, input) {
      requireMutationAuthority(authority);
      return library.writeAsset(input);
    },

    async deleteAsset(authority, assetId) {
      requireMutationAuthority(authority);
      return library.deleteAsset(assetId);
    },
  };

  function requireAvailable() {
    if (closed || !opened) throw unavailable();
  }

  function requireSession(token) {
    requireAvailable();
    pruneExpired();
    const session = typeof token === 'string' ? sessions.get(token) : null;
    if (!session) {
      throw new RuntimeProjectServiceError(
        'session_invalid',
        'The Runtime browser session is invalid or expired.',
      );
    }
    return session;
  }

  function requireChromeLease(sessionToken, leaseToken) {
    expireAuthority();
    if (!editorLease
      || editorLease.owner !== 'chrome'
      || editorLease.sessionToken !== sessionToken
      || editorLease.token !== leaseToken) {
      throw leaseInvalid();
    }
    return editorLease;
  }

  function requireCodexLease(codexSessionId) {
    requireAvailable();
    expireAuthority();
    if (!editorLease
      || editorLease.owner !== 'codex'
      || editorLease.codexSessionId !== codexSessionId) {
      throw leaseInvalid();
    }
    return editorLease;
  }

  function requireMutationAuthority(authority) {
    requireAvailable();
    if (!authority || typeof authority !== 'object') throw leaseInvalid();
    if (authority.delegationToken !== undefined) {
      consumeDelegation(authority.delegationToken, authority.actionId);
      return;
    }
    requireSession(authority.sessionToken);
    requireChromeLease(authority.sessionToken, authority.leaseToken);
  }

  function consumeDelegation(token, actionId) {
    expireAuthority();
    const delegation = typeof token === 'string' ? delegations.get(token) : null;
    if (!delegation
      || delegation.actionId !== actionId
      || !editorLease
      || editorLease.owner !== 'codex'
      || editorLease.codexSessionId !== delegation.codexSessionId) {
      throw leaseInvalid();
    }
    delegations.delete(token);
  }

  function pruneExpired() {
    const current = now();
    for (const [token, session] of sessions) {
      if (current >= session.expiresAt) {
        sessions.delete(token);
        if (editorLease?.owner === 'chrome' && editorLease.sessionToken === token) {
          editorLease = null;
        }
      }
    }
    expireAuthority(current);
  }

  function expireAuthority(current = now()) {
    if (editorLease && current >= editorLease.expiresAt) editorLease = null;
    for (const [token, delegation] of delegations) {
      if (current >= delegation.expiresAt) delegations.delete(token);
    }
  }

  return service;
}

function isProjectLibrary(value) {
  return value
    && typeof value === 'object'
    && ['open', 'close', 'listProjects', 'openProject', 'saveSnapshot',
      'updateViewport', 'renameProject', 'deleteProject', 'writeAsset',
      'readAsset', 'getAssetMetadata', 'deleteAsset']
      .every((name) => typeof value[name] === 'function');
}

function readTtl(value, fallback, maximum) {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0 || selected > maximum) {
    throw new RuntimeProjectServiceError('invalid_service', 'A Runtime authority lifetime is invalid.');
  }
  return selected;
}

function uniqueToken(map, createToken) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const token = opaqueToken(createToken);
    if (!map.has(token)) return token;
  }
  throw new RuntimeProjectServiceError('token_generation_failed', 'The Runtime could not create an opaque credential.');
}

function opaqueToken(createToken) {
  const token = createToken();
  if (typeof token === 'string' && /^[A-Za-z0-9_-]{16,128}$/u.test(token)) return token;
  throw new RuntimeProjectServiceError('token_generation_failed', 'The Runtime could not create an opaque credential.');
}

function requireOpaqueId(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || value.includes(' ')) {
    throw new RuntimeProjectServiceError('invalid_request', `${label} is invalid.`);
  }
}

function publicChromeLease(lease) {
  return { mode: 'chrome', token: lease.token, expiresAt: lease.expiresAt };
}

function unavailable() {
  return new RuntimeProjectServiceError('runtime_unavailable', 'The Runtime project service is unavailable.');
}

function busy() {
  return new RuntimeProjectServiceError('editor_busy', 'Another editor owns the Runtime editing lease.');
}

function leaseInvalid() {
  return new RuntimeProjectServiceError('editor_lease_invalid', 'The Runtime editing lease is invalid or expired.');
}
