import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Transport } from '../transport';
import type { LogEntry } from '../types';
import { DEFAULT_LOG_CONFIG } from '../types';

function makeEntry(level: LogEntry['level'] = 'info'): LogEntry {
  return {
    id: '1',
    ts: 0,
    level,
    target: 't',
    message: 'm',
    fields: {},
  };
}

describe('Transport', () => {
  let transport: Transport;
  let consoleLog: ReturnType<typeof vi.spyOn>;
  let consoleError: ReturnType<typeof vi.spyOn>;
  let consoleWarn: ReturnType<typeof vi.spyOn>;
  let invokeMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    invokeMock = vi.fn().mockResolvedValue(undefined);
    (globalThis as any).window = (globalThis as any).window || {};
    (globalThis as any).window.__TAURI_INTERNALS__ = { invoke: invokeMock };
    consoleLog = vi.spyOn(console, 'info').mockImplementation(() => {});
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    transport = new Transport();
  });

  afterEach(() => {
    consoleLog.mockRestore();
    consoleError.mockRestore();
    consoleWarn.mockRestore();
    transport.flushSync();
    delete (globalThis as any).window.__TAURI_INTERNALS__;
  });

  it('writes to console when config.console=true', () => {
    transport.send(makeEntry(), { ...DEFAULT_LOG_CONFIG });
    expect(consoleLog).toHaveBeenCalled();
  });

  it('skips console when config.console=false', () => {
    transport.send(makeEntry(), { ...DEFAULT_LOG_CONFIG, console: false });
    expect(consoleLog).not.toHaveBeenCalled();
  });

  it('invokes Tauri when persist=true', () => {
    transport.send(makeEntry(), { ...DEFAULT_LOG_CONFIG });
    transport.flushSync();
    expect(invokeMock).toHaveBeenCalled();
    expect(invokeMock.mock.calls[0][0]).toBe('append_frontend_log');
    expect(invokeMock.mock.calls[0][1]).toMatchObject({ entry: expect.any(Object) });
  });

  it('skips Tauri when persist=false', () => {
    transport.send(makeEntry(), { ...DEFAULT_LOG_CONFIG, persist: false });
    transport.flushSync();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('routes error to console.error', () => {
    transport.send(makeEntry('error'), { ...DEFAULT_LOG_CONFIG });
    expect(consoleError).toHaveBeenCalled();
  });

  it('routes warn to console.warn', () => {
    transport.send(makeEntry('warn'), { ...DEFAULT_LOG_CONFIG });
    expect(consoleWarn).toHaveBeenCalled();
  });
});