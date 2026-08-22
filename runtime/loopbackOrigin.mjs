/* global URL */

export function parseLoopbackOrigin(value, errorMessage) {
  try {
    const origin = new URL(value);
    if (
      origin.protocol !== 'http:'
      || origin.hostname !== '127.0.0.1'
      || !origin.port
      || origin.username
      || origin.password
      || origin.pathname !== '/'
      || origin.search
      || origin.hash
    ) {
      throw new Error();
    }
    return origin.origin;
  } catch {
    throw new Error(errorMessage);
  }
}
