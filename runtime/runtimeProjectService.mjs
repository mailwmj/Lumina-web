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
  const editorLeases = new Map();
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
      editorLeases.clear();
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
      for (const [projectId, lease] of editorLeases) {
        if (lease.owner === 'chrome' && lease.sessionToken === sessionToken) {
          clearProjectAuthority(projectId);
        }
      }
      return Boolean(session);
    },

    getEditorStatus(sessionToken, projectId) {
      requireSession(sessionToken);
      requireOpaqueId(projectId, 'projectId');
      expireAuthority();
      const lease = editorLeases.get(projectId);
      if (!lease) return { mode: 'available', projectId };
      if (lease.owner === 'chrome') {
        return {
          mode: lease.sessionToken === sessionToken ? 'chrome' : 'busy',
          projectId,
          expiresAt: lease.expiresAt,
        };
      }
      return { mode: 'codex', projectId, expiresAt: lease.expiresAt };
    },

    acquireChromeLease(sessionToken, projectId, options = {}) {
      requireSession(sessionToken);
      requireOpaqueId(projectId, 'projectId');
      expireAuthority();
      const existing = editorLeases.get(projectId);
      if (existing) {
        if (existing.owner === 'chrome' && existing.sessionToken === sessionToken) {
          existing.expiresAt = now() + leaseTtlMs;
          return publicChromeLease(existing);
        }
        if (options.force !== true) {
          throw busy();
        }
        clearProjectAuthority(projectId);
      }
      const lease = {
        owner: 'chrome',
        projectId,
        sessionToken,
        token: opaqueToken(createToken),
        expiresAt: now() + leaseTtlMs,
      };
      editorLeases.set(projectId, lease);
      return publicChromeLease(lease);
    },

    renewChromeLease(sessionToken, projectId, leaseToken) {
      requireSession(sessionToken);
      const lease = requireChromeLease(sessionToken, projectId, leaseToken);
      lease.expiresAt = now() + leaseTtlMs;
      return publicChromeLease(lease);
    },

    releaseChromeLease(sessionToken, projectId, leaseToken) {
      requireSession(sessionToken);
      requireChromeLease(sessionToken, projectId, leaseToken);
      clearProjectAuthority(projectId);
      return true;
    },

    handoffToCodex(sessionToken, projectId, leaseToken, codexSessionId) {
      requireSession(sessionToken);
      requireOpaqueId(projectId, 'projectId');
      requireOpaqueId(codexSessionId, 'codexSessionId');
      requireChromeLease(sessionToken, projectId, leaseToken);
      clearDelegationsForProject(projectId);
      const lease = {
        owner: 'codex',
        projectId,
        codexSessionId,
        token: opaqueToken(createToken),
        expiresAt: now() + leaseTtlMs,
      };
      editorLeases.set(projectId, lease);
      return publicCodexLease(lease);
    },

    abortCodexHandoff(sessionToken, projectId, codexSessionId) {
      requireSession(sessionToken);
      requireOpaqueId(projectId, 'projectId');
      requireOpaqueId(codexSessionId, 'codexSessionId');
      expireAuthority();
      const lease = editorLeases.get(projectId);
      if (
        !lease
        || lease.owner !== 'codex'
        || lease.codexSessionId !== codexSessionId
      ) {
        return false;
      }
      clearProjectAuthority(projectId);
      return true;
    },

    renewCodexLease(codexSessionId, projectId) {
      const lease = requireCodexLease(codexSessionId, projectId);
      lease.expiresAt = now() + leaseTtlMs;
      return publicCodexLease(lease);
    },

    revokeCodexLease(codexSessionId, projectId) {
      requireAvailable();
      requireOpaqueId(projectId, 'projectId');
      expireAuthority();
      const lease = editorLeases.get(projectId);
      if (!lease) return false;
      if (lease.owner !== 'codex' || lease.codexSessionId !== codexSessionId) {
        throw leaseInvalid();
      }
      clearProjectAuthority(projectId);
      return true;
    },

    createCodexDelegation(codexSessionId, projectId, actionId) {
      const lease = requireCodexLease(codexSessionId, projectId);
      requireOpaqueId(actionId, 'actionId');
      const token = uniqueToken(delegations, createToken);
      const expiresAt = Math.min(lease.expiresAt, now() + delegationTtlMs);
      delegations.set(token, { actionId, codexSessionId, projectId, expiresAt });
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
      requireMutationAuthority(authority, record?.id);
      return library.saveSnapshot(record);
    },

    async updateViewport(authority, projectId, viewportJson) {
      requireMutationAuthority(authority, projectId);
      return library.updateViewport(projectId, viewportJson);
    },

    async renameProject(authority, projectId, name, updatedAt) {
      requireMutationAuthority(authority, projectId);
      return library.renameProject(projectId, name, updatedAt);
    },

    async deleteProject(authority, projectId) {
      requireMutationAuthority(authority, projectId);
      return library.deleteProject(projectId);
    },

    async writeAsset(authority, input) {
      requireMutationAuthority(authority, input?.projectId);
      return library.writeAsset(input);
    },

    async deleteAsset(authority, projectId, assetId) {
      requireOpaqueId(projectId, 'projectId');
      const metadata = await library.getAssetMetadata(assetId);
      if (!metadata || metadata.projectId !== projectId) return false;
      requireMutationAuthority(authority, projectId);
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

  function requireChromeLease(sessionToken, projectId, leaseToken) {
    requireOpaqueId(projectId, 'projectId');
    expireAuthority();
    const lease = editorLeases.get(projectId);
    if (!lease
      || lease.owner !== 'chrome'
      || lease.sessionToken !== sessionToken
      || lease.token !== leaseToken) {
      throw leaseInvalid();
    }
    return lease;
  }

  function requireCodexLease(codexSessionId, projectId) {
    requireAvailable();
    requireOpaqueId(projectId, 'projectId');
    expireAuthority();
    const lease = editorLeases.get(projectId);
    if (!lease
      || lease.owner !== 'codex'
      || lease.codexSessionId !== codexSessionId) {
      throw leaseInvalid();
    }
    return lease;
  }

  function requireMutationAuthority(authority, projectId) {
    requireAvailable();
    requireOpaqueId(projectId, 'projectId');
    if (!authority || typeof authority !== 'object') throw leaseInvalid();
    if (authority.delegationToken !== undefined) {
      consumeDelegation(authority.delegationToken, authority.actionId, projectId);
      return;
    }
    requireSession(authority.sessionToken);
    requireChromeLease(authority.sessionToken, projectId, authority.leaseToken);
  }

  function consumeDelegation(token, actionId, projectId) {
    expireAuthority();
    const delegation = typeof token === 'string' ? delegations.get(token) : null;
    const lease = delegation ? editorLeases.get(delegation.projectId) : null;
    if (!delegation
      || delegation.actionId !== actionId
      || delegation.projectId !== projectId
      || !lease
      || lease.owner !== 'codex'
      || lease.codexSessionId !== delegation.codexSessionId) {
      throw leaseInvalid();
    }
    delegations.delete(token);
  }

  function pruneExpired() {
    const current = now();
    for (const [token, session] of sessions) {
      if (current >= session.expiresAt) {
        sessions.delete(token);
        for (const [projectId, lease] of editorLeases) {
          if (lease.owner === 'chrome' && lease.sessionToken === token) {
            clearProjectAuthority(projectId);
          }
        }
      }
    }
    expireAuthority(current);
  }

  function expireAuthority(current = now()) {
    for (const [projectId, lease] of editorLeases) {
      if (current >= lease.expiresAt) clearProjectAuthority(projectId);
    }
    for (const [token, delegation] of delegations) {
      if (current >= delegation.expiresAt) delegations.delete(token);
    }
  }

  function clearProjectAuthority(projectId) {
    editorLeases.delete(projectId);
    clearDelegationsForProject(projectId);
  }

  function clearDelegationsForProject(projectId) {
    for (const [token, delegation] of delegations) {
      if (delegation.projectId === projectId) delegations.delete(token);
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
  return {
    mode: 'chrome',
    projectId: lease.projectId,
    token: lease.token,
    expiresAt: lease.expiresAt,
  };
}

function publicCodexLease(lease) {
  return {
    mode: 'codex',
    projectId: lease.projectId,
    expiresAt: lease.expiresAt,
  };
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
