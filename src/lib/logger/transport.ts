import { invoke } from '@tauri-apps/api/core';
import type { LogConfig, LogEntry } from './types';
import { isLevelEnabled, resolveLevel } from './levels';
import { serializeFields } from './serialize';
import { useLogStore } from './store';

const FLUSH_INTERVAL_MS = 200;

export class Transport {
  private queue: LogEntry[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  send(entry: LogEntry, config: LogConfig): void {
    const effective = resolveLevel(entry.target, config);
    if (!isLevelEnabled(entry.level, effective)) return;

    if (config.console) this.writeConsole(entry, config);
    useLogStore.getState().appendEntry(entry);

    if (config.persist && this.isTauri()) {
      this.queue.push(entry);
      this.scheduleFlush();
    }
  }

  flushSync(): void {
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0);
    void this.flush(batch);
  }

  private isTauri(): boolean {
    return typeof globalThis !== 'undefined'
      && typeof (globalThis as any).window !== 'undefined'
      && typeof (globalThis as any).window.__TAURI_INTERNALS__ !== 'undefined';
  }

  private writeConsole(entry: LogEntry, config: LogConfig): void {
    const tag = `[${entry.target}]`;
    const text = config.consoleTimestamps
      ? `${new Date(entry.ts).toISOString()} ${tag} ${entry.message}`
      : `${tag} ${entry.message}`;
    const args: unknown[] = [text];
    if (Object.keys(entry.fields).length > 0) {
      args.push(entry.fields);
    }
    const fn =
      entry.level === 'error' ? console.error :
      entry.level === 'warn' ? console.warn :
      console.info;
    fn(...args);
  }

  private scheduleFlush(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flushSync();
    }, FLUSH_INTERVAL_MS);
  }

  private async flush(batch: LogEntry[]): Promise<void> {
    for (const entry of batch) {
      try {
        await invoke('append_frontend_log', {
          entry: {
            level: entry.level,
            target: entry.target,
            message: entry.message,
            fields: serializeFields(entry.fields),
            ts_ms: entry.ts,
          },
        });
      } catch (err) {
        // 静默：后端不可用不阻塞前端
      }
    }
  }
}

export const globalTransport = new Transport();