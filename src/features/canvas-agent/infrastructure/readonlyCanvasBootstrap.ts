export interface ReadonlyCanvasBootstrap {
  endpoint: string;
  sessionId: string;
  token: string;
  expiresAt: number;
}

interface FragmentLocation {
  hash: string;
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
    if (!isReadonlyCanvasBootstrap(value)) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

function isReadonlyCanvasBootstrap(value: Partial<ReadonlyCanvasBootstrap>): value is ReadonlyCanvasBootstrap {
  try {
    const endpoint = new URL(value.endpoint ?? '');
    return endpoint.protocol === 'http:'
      && endpoint.hostname === '127.0.0.1'
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
