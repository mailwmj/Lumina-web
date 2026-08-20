export class NetworkUnavailableError extends Error {
  constructor() {
    super('Network access is unavailable while offline.');
    this.name = 'NetworkUnavailableError';
  }
}

export function assertNetworkAvailable(isOnline: boolean | undefined = (
  typeof navigator === 'undefined' ? undefined : navigator.onLine
)): void {
  if (isOnline === false) {
    throw new NetworkUnavailableError();
  }
}
