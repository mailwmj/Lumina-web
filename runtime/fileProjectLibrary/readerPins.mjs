import { FileProjectLibraryError, READER_PIN_GATES } from './core.mjs';

export function readerPinGate(state) {
  const existing = READER_PIN_GATES.get(state.root);
  if (existing) return existing;
  const created = { closed: false, waiters: [] };
  READER_PIN_GATES.set(state.root, created);
  return created;
}

export function isReaderPinGateClosed(state) {
  return readerPinGate(state).closed;
}

export async function waitForReaderPinGate(state) {
  const gate = readerPinGate(state);
  if (!gate.closed) return;
  await new Promise((resolve) => gate.waiters.push(resolve));
}

export function closeReaderPinGate(state) {
  const gate = readerPinGate(state);
  if (gate.closed) throw new FileProjectLibraryError('library_busy', 'Reader pin authorization is already in progress.');
  gate.closed = true;
  return () => {
    gate.closed = false;
    for (const resolve of gate.waiters.splice(0)) resolve();
  };
}

export async function withReaderPinBarrier(state, operation) {
  const release = closeReaderPinGate(state);
  try {
    return await operation();
  } finally {
    release();
  }
}
