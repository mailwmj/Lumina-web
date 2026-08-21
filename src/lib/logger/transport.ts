import type { LogConfig, LogEntry } from './types';
import { isLevelEnabled, resolveLevel } from './levels';
import { useLogStore } from './store';

export class Transport {
  send(entry: LogEntry, config: LogConfig): void {
    const effective = resolveLevel(entry.target, config);
    if (!isLevelEnabled(entry.level, effective)) return;

    if (config.console) this.writeConsole(entry, config);
    useLogStore.getState().appendEntry(entry);
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

}

export const globalTransport = new Transport();
