import { create } from 'zustand';
import type { LogEntry, Level } from './types';
import { RingBuffer } from './ringBuffer';

const RING_CAPACITY = 500;

interface LogStore {
  buffer: RingBuffer;
  open: boolean;
  minimized: boolean;
  levelFilter: Set<Level>;
  namespaceFilter: string | null;
  textQuery: string;
  subscribe(listener: () => void): () => void;
  toggleOpen(): void;
  setOpen(v: boolean): void;
  setMinimized(v: boolean): void;
  toggleLevelFilter(level: Level): void;
  setNamespaceFilter(ns: string | null): void;
  setTextQuery(q: string): void;
  appendEntry(entry: LogEntry): void;
  clearBuffer(): void;
  snapshot(): readonly LogEntry[];
}

let listeners = new Set<() => void>();
function notify() {
  for (const l of listeners) l();
}

export const useLogStore = create<LogStore>((set, get) => ({
  buffer: new RingBuffer(RING_CAPACITY),
  open: false,
  minimized: false,
  levelFilter: new Set<Level>(['debug', 'info', 'warn', 'error']),
  namespaceFilter: null,
  textQuery: '',
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  toggleOpen() {
    set((s) => ({ open: !s.open, minimized: false }));
    notify();
  },
  setOpen(v) {
    set({ open: v, minimized: false });
    notify();
  },
  setMinimized(v) {
    set({ minimized: v });
    notify();
  },
  toggleLevelFilter(level) {
    const cur = new Set(get().levelFilter);
    if (cur.has(level)) cur.delete(level);
    else cur.add(level);
    set({ levelFilter: cur });
    notify();
  },
  setNamespaceFilter(ns) {
    set({ namespaceFilter: ns });
    notify();
  },
  setTextQuery(q) {
    set({ textQuery: q });
    notify();
  },
  appendEntry(entry) {
    get().buffer.push(entry);
    notify();
  },
  clearBuffer() {
    get().buffer.clear();
    notify();
  },
  snapshot() {
    return get().buffer.entries();
  },
}));