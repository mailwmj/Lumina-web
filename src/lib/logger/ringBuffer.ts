import type { LogEntry } from './types';

/**
 * Fixed-capacity ring buffer that evicts oldest entries when full.
 */
export class RingBuffer {
  private capacity: number;
  private buffer: LogEntry[];
  private head: number = 0;
  private count: number = 0;

  constructor(capacity: number) {
    if (capacity <= 0) {
      throw new Error('Capacity must be positive');
    }
    this.capacity = capacity;
    this.buffer = new Array(capacity);
  }

  push(entry: LogEntry): void {
    this.buffer[this.head] = entry;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) {
      this.count++;
    }
  }

  size(): number {
    return this.count;
  }

  isEmpty(): boolean {
    return this.count === 0;
  }

  toArray(): LogEntry[] {
    if (this.count === 0) {
      return [];
    }
    const result: LogEntry[] = new Array(this.count);
    for (let i = 0; i < this.count; i++) {
      const idx = (this.head - this.count + i + this.capacity) % this.capacity;
      result[i] = this.buffer[idx]!;
    }
    return result;
  }

  entries(): LogEntry[] {
    return this.toArray();
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
    this.buffer = new Array(this.capacity);
  }
}