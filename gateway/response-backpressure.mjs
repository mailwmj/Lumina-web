function abortError(message) {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

export function waitForResponseDrain(response, signal) {
  if (signal?.aborted || response.destroyed || response.writableEnded) {
    return Promise.reject(abortError('The response stream is no longer writable.'));
  }

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      response.removeListener('drain', onDrain);
      response.removeListener('close', onClose);
      response.removeListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };
    const settle = (error) => {
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onDrain = () => settle();
    const onClose = () => settle(abortError('The response stream closed before it drained.'));
    const onError = (error) => settle(error);
    const onAbort = () => settle(abortError('The response stream was aborted before it drained.'));

    response.once('drain', onDrain);
    response.once('close', onClose);
    response.once('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });

    if (signal?.aborted || response.destroyed || response.writableEnded) onAbort();
  });
}
