export interface WebCanvasBootstrap {
  bridge: 'web';
  endpoint: string;
  canonicalOrigin: string;
  sessionId: string;
  token: string;
  expiresAt: number;
}

let capturedBootstrap: WebCanvasBootstrap | null = null;

interface FragmentLocation {
  hash: string;
  origin: string;
  pathname: string;
  search: string;
}

interface FragmentHistory {
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
}

export function consumeWebCanvasBootstrap(
  location: FragmentLocation,
  history: FragmentHistory,
): WebCanvasBootstrap | null {
  const rawBootstrap = new URLSearchParams(location.hash.slice(1)).get('lumina-canvas');
  if (!rawBootstrap) {
    return null;
  }
  try {
    const value = JSON.parse(rawBootstrap) as Partial<WebCanvasBootstrap>;
    if (value.bridge !== 'web') {
      return null;
    }
    history.replaceState(null, '', `${location.pathname}${location.search}`);
    if (!isWebCanvasBootstrap(value) || location.origin !== value.canonicalOrigin) {
      return null;
    }
    return value;
  } catch {
    history.replaceState(null, '', `${location.pathname}${location.search}`);
    return null;
  }
}

export function captureWebCanvasBootstrap(
  location: FragmentLocation,
  history: FragmentHistory,
): WebCanvasBootstrap | null {
  capturedBootstrap ??= consumeWebCanvasBootstrap(location, history);
  return capturedBootstrap;
}

export function getCapturedWebCanvasBootstrap(): WebCanvasBootstrap | null {
  return capturedBootstrap;
}

export function clearCapturedWebCanvasBootstrap(bootstrap: WebCanvasBootstrap): void {
  if (capturedBootstrap === bootstrap) {
    capturedBootstrap = null;
  }
}

function isWebCanvasBootstrap(value: Partial<WebCanvasBootstrap>): value is WebCanvasBootstrap {
  return value.bridge === 'web'
    && isExplicitLoopbackOrigin(value.endpoint)
    && isExplicitLoopbackOrigin(value.canonicalOrigin)
    && typeof value.sessionId === 'string'
    && value.sessionId.length > 0
    && typeof value.token === 'string'
    && value.token.length >= 16
    && typeof value.expiresAt === 'number'
    && Number.isFinite(value.expiresAt);
}

function isExplicitLoopbackOrigin(value: unknown): value is string {
  try {
    const origin = new URL(typeof value === 'string' ? value : '');
    return origin.protocol === 'http:'
      && origin.hostname === '127.0.0.1'
      && Boolean(origin.port)
      && origin.pathname === '/'
      && !origin.search
      && !origin.hash
      && !origin.username
      && !origin.password;
  } catch {
    return false;
  }
}
