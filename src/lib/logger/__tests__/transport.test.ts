import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Transport } from '../transport';
import { useLogStore } from '../store';
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

  beforeEach(() => {
    useLogStore.getState().clearBuffer();
    consoleLog = vi.spyOn(console, 'info').mockImplementation(() => {});
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    transport = new Transport();
  });

  afterEach(() => {
    consoleLog.mockRestore();
    consoleError.mockRestore();
    consoleWarn.mockRestore();
  });

  it('writes to console when config.console=true', () => {
    transport.send(makeEntry(), { ...DEFAULT_LOG_CONFIG });
    expect(consoleLog).toHaveBeenCalled();
  });

  it('skips console when config.console=false', () => {
    transport.send(makeEntry(), { ...DEFAULT_LOG_CONFIG, console: false });
    expect(consoleLog).not.toHaveBeenCalled();
  });

  it('appends enabled entries to the browser ring buffer', () => {
    const entry = makeEntry();
    transport.send(entry, { ...DEFAULT_LOG_CONFIG });
    expect(useLogStore.getState().snapshot()).toEqual([entry]);
  });

  it('does not append entries filtered by the configured level', () => {
    transport.send(makeEntry('info'), { ...DEFAULT_LOG_CONFIG, level: 'warn' });
    expect(useLogStore.getState().snapshot()).toEqual([]);
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
