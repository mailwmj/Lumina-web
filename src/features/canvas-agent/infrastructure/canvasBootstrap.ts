import { captureReadonlyCanvasBootstrap } from './readonlyCanvasBootstrap';
import { captureWebCanvasBootstrap } from './webCanvasBootstrap';

interface CanvasBootstrapLocation {
  hash: string;
  origin: string;
  pathname: string;
  search: string;
}

interface CanvasBootstrapHistory {
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
}

export function captureCanvasBootstrap(
  location: CanvasBootstrapLocation,
  history: CanvasBootstrapHistory,
): void {
  captureWebCanvasBootstrap(location, history);
  captureReadonlyCanvasBootstrap(location, history);
}
