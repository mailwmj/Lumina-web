export interface ReadonlyCanvasBootstrap {
  endpoint: string;
  canonicalOrigin: string;
  sessionId: string;
  token: string;
  expiresAt: number;
}

let capturedBootstrap: ReadonlyCanvasBootstrap | null = null;

interface FragmentLocation {
  hash: string;
  origin: string;
  pathname: string;
  search: string;
}

interface FragmentHistory {
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
}

export function consumeReadonlyCanvasBootstrap(
  location: FragmentLocation,
  history: FragmentHistory,
): ReadonlyCanvasBootstrap | null {
  const rawBootstrap = new URLSearchParams(location.hash.slice(1)).get('lumina-canvas');
  if (!rawBootstrap) {
    return null;
  }
  history.replaceState(null, '', `${location.pathname}${location.search}`);
  try {
    const value = JSON.parse(rawBootstrap) as Partial<ReadonlyCanvasBootstrap>;
    if (!isReadonlyCanvasBootstrap(value) || location.origin !== value.canonicalOrigin) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

export function captureReadonlyCanvasBootstrap(
  location: FragmentLocation,
  history: FragmentHistory,
): ReadonlyCanvasBootstrap | null {
  capturedBootstrap ??= consumeReadonlyCanvasBootstrap(location, history);
  return capturedBootstrap;
}

export function getCapturedReadonlyCanvasBootstrap(): ReadonlyCanvasBootstrap | null {
  return capturedBootstrap;
}

export function clearCapturedReadonlyCanvasBootstrap(bootstrap: ReadonlyCanvasBootstrap): void {
  if (capturedBootstrap === bootstrap) {
    capturedBootstrap = null;
  }
}

function isReadonlyCanvasBootstrap(value: Partial<ReadonlyCanvasBootstrap>): value is ReadonlyCanvasBootstrap {
  try {
    const endpoint = new URL(value.endpoint ?? '');
    const canonicalOrigin = new URL(value.canonicalOrigin ?? '');
    return endpoint.protocol === 'http:'
      && endpoint.hostname === '127.0.0.1'
      && Boolean(endpoint.port)
      && endpoint.pathname === '/'
      && !endpoint.search
      && !endpoint.hash
      && !endpoint.username
      && !endpoint.password
      && canonicalOrigin.protocol === 'http:'
      && canonicalOrigin.hostname === '127.0.0.1'
      && Boolean(canonicalOrigin.port)
      && canonicalOrigin.pathname === '/'
      && !canonicalOrigin.search
      && !canonicalOrigin.hash
      && !canonicalOrigin.username
      && !canonicalOrigin.password
      && typeof value.sessionId === 'string'
      && value.sessionId.length > 0
      && typeof value.token === 'string'
      && value.token.length >= 16
      && typeof value.expiresAt === 'number'
      && Number.isFinite(value.expiresAt);
  } catch {
    return false;
  }
}
