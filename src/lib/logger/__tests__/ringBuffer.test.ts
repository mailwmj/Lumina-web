import { describe, it, expect, beforeEach } from 'vitest';
import { RingBuffer } from '../ringBuffer';
import type { LogEntry } from '../types';

describe('RingBuffer', () => {
  let buffer: RingBuffer;

  beforeEach(() => {
    buffer = new RingBuffer(3);
  });

  it('starts empty', () => {
    expect(buffer.size()).toBe(0);
    expect(buffer.isEmpty()).toBe(true);
  });

  it('pushes items and reports size', () => {
    const entry: LogEntry = {
      id: '1',
      ts: 1000,
      level: 'info',
      target: 'test',
      message: 'msg',
      fields: {},
    };
    buffer.push(entry);
    expect(buffer.size()).toBe(1);
    expect(buffer.isEmpty()).toBe(false);
  });

  it('evicts oldest when capacity exceeded', () => {
    const entries: LogEntry[] = [
      { id: '1', ts: 1000, level: 'info', target: 'test', message: 'msg1', fields: {} },
      { id: '2', ts: 1001, level: 'info', target: 'test', message: 'msg2', fields: {} },
      { id: '3', ts: 1002, level: 'info', target: 'test', message: 'msg3', fields: {} },
      { id: '4', ts: 1003, level: 'info', target: 'test', message: 'msg4', fields: {} },
    ];
    entries.forEach((e) => buffer.push(e));

    expect(buffer.size()).toBe(3);
    // Oldest entries should be evicted
    const items = buffer.toArray();
    expect(items.map((e) => e.id)).toEqual(['2', '3', '4']);
  });

  it('returns all items in order via toArray', () => {
    const entries: LogEntry[] = [
      { id: '1', ts: 1000, level: 'info', target: 'test', message: 'msg1', fields: {} },
      { id: '2', ts: 1001, level: 'info', target: 'test', message: 'msg2', fields: {} },
    ];
    entries.forEach((e) => buffer.push(e));

    const items = buffer.toArray();
    expect(items.map((e) => e.message)).toEqual(['msg1', 'msg2']);
  });

  it('clears all items', () => {
    const entry: LogEntry = {
      id: '1',
      ts: 1000,
      level: 'info',
      target: 'test',
      message: 'msg',
      fields: {},
    };
    buffer.push(entry);
    buffer.clear();

    expect(buffer.size()).toBe(0);
    expect(buffer.isEmpty()).toBe(true);
  });
});