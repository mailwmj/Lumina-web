import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Maximize2, Minus, X } from '@/components/ui/icons';
import { UiTooltip } from '@/components/ui';
import { useLogStore } from './store';
import type { Level, LogEntry } from './types';

const ALL_LEVELS: Level[] = ['debug', 'info', 'warn', 'error'];
const LEVEL_COLOR: Record<Level, string> = {
  debug: 'text-gray-400',
  info: 'text-blue-400',
  warn: 'text-yellow-400',
  error: 'text-red-400',
};

export function LogPanel(): JSX.Element | null {
  const { t } = useTranslation();
  const open = useLogStore((s) => s.open);
  const minimized = useLogStore((s) => s.minimized);
  const levelFilter = useLogStore((s) => s.levelFilter);
  const namespaceFilter = useLogStore((s) => s.namespaceFilter);
  const textQuery = useLogStore((s) => s.textQuery);
  const buffer = useLogStore((s) => s.buffer);
  const toggleLevelFilter = useLogStore((s) => s.toggleLevelFilter);
  const setNamespaceFilter = useLogStore((s) => s.setNamespaceFilter);
  const setTextQuery = useLogStore((s) => s.setTextQuery);
  const setMinimized = useLogStore((s) => s.setMinimized);
  const setOpen = useLogStore((s) => s.setOpen);
  const clearBuffer = useLogStore((s) => s.clearBuffer);

  // Subscribe to ring buffer changes to force re-render (zustand doesn't deep watch by default)
  const [, force] = useState(0);
  useEffect(() => useLogStore.getState().subscribe(() => force((n) => n + 1)), []);

  if (!open) return null;

  const allEntries = buffer.entries();
  const namespaces = Array.from(new Set(allEntries.map((e) => e.target))).sort();

  const visible = allEntries.filter((e) => {
    if (!levelFilter.has(e.level)) return false;
    if (namespaceFilter && e.target !== namespaceFilter) return false;
    if (textQuery) {
      const q = textQuery.toLowerCase();
      if (!e.message.toLowerCase().includes(q) &&
          !JSON.stringify(e.fields).toLowerCase().includes(q)) {
        return false;
      }
    }
    return true;
  }).slice().reverse();

  return (
    <div
      data-testid="log-panel"
      className="fixed bottom-4 right-4 z-[9999] flex w-[min(480px,calc(100vw-32px))] flex-col rounded-[10px] border border-[var(--ui-border-soft)] bg-[var(--ui-surface-panel)] text-text-dark shadow-[var(--ui-shadow-panel)]"
      style={{ height: minimized ? 40 : 320 }}
    >
      <div className="flex items-center gap-2 border-b border-[var(--ui-border-soft)] px-3 py-2">
        <span className="text-sm font-semibold flex-1">{t('logger.panel.title')}</span>
        <UiTooltip content={t('logger.panel.minimize')}>
          <button
            onClick={() => setMinimized(!minimized)}
            className="flex h-7 w-7 items-center justify-center rounded text-text-muted hover:bg-[var(--ui-hover)] hover:text-text-dark"
            aria-label={t('logger.panel.minimize')}
          >
            {minimized ? <Maximize2 className="h-3.5 w-3.5" /> : <Minus className="h-3.5 w-3.5" />}
          </button>
        </UiTooltip>
        <UiTooltip content={t('logger.panel.close')}>
          <button
            onClick={() => setOpen(false)}
            className="flex h-7 w-7 items-center justify-center rounded text-text-muted hover:bg-[var(--ui-hover)] hover:text-text-dark"
            aria-label={t('logger.panel.close')}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </UiTooltip>
      </div>

      {!minimized && (
        <>
          <div className="flex items-center gap-1 border-b border-[var(--ui-border-soft)] px-2 py-1 text-xs">
            {ALL_LEVELS.map((lv) => (
              <button
                key={lv}
                onClick={() => toggleLevelFilter(lv)}
                className={`px-2 py-0.5 rounded ${
                  levelFilter.has(lv) ? LEVEL_COLOR[lv] + ' bg-[var(--ui-hover)]' : 'text-text-muted/45'
                }`}
              >
                {lv}
              </button>
            ))}
            <input
              type="text"
              value={textQuery}
              onChange={(e) => setTextQuery(e.target.value)}
              placeholder={t('logger.panel.search')}
              className="ml-auto w-32 rounded border border-[var(--ui-border-soft)] bg-[var(--ui-surface-field)] px-2 py-0.5 text-xs outline-none focus:border-accent"
            />
            <button
              onClick={clearBuffer}
              className="rounded px-2 py-0.5 text-xs hover:bg-[var(--ui-hover)]"
            >
              {t('logger.panel.clear')}
            </button>
          </div>

          <div className="flex max-h-12 flex-wrap gap-1 overflow-y-auto border-b border-[var(--ui-border-soft)] px-2 py-1 font-mono text-[10px]">
            <button
              onClick={() => setNamespaceFilter(null)}
              className={`rounded px-1.5 py-0.5 ${namespaceFilter === null ? 'bg-accent/15 text-accent' : 'hover:bg-[var(--ui-hover)]'}`}
            >
              all
            </button>
            {namespaces.map((ns) => (
              <button
                key={ns}
                onClick={() => setNamespaceFilter(ns)}
                className={`px-1.5 py-0.5 rounded ${
                  namespaceFilter === ns ? 'bg-accent/15 text-accent' : 'hover:bg-[var(--ui-hover)]'
                }`}
              >
                {ns}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto font-mono text-[11px] leading-tight">
            {visible.length === 0 ? (
              <div className="py-8 text-center text-text-muted">
                {allEntries.length === 0 ? t('logger.panel.empty') : t('logger.panel.noResults')}
              </div>
            ) : (
              visible.map((entry) => <LogLine key={entry.id} entry={entry} />)
            )}
          </div>
        </>
      )}
    </div>
  );
}

function LogLine({ entry }: { entry: LogEntry }) {
  return (
    <div className="border-b border-[var(--ui-border-soft)] px-2 py-1 hover:bg-[var(--ui-hover)]">
      <span className={`font-bold ${LEVEL_COLOR[entry.level]}`}>
        {entry.level.toUpperCase().padEnd(5)}
      </span>
      <span className="ml-2 text-text-muted">{entry.target}</span>
      <span className="ml-2">{entry.message}</span>
      {Object.keys(entry.fields).length > 0 && (
        <details className="ml-2 mt-1">
          <summary className="cursor-pointer text-text-muted">fields</summary>
          <pre className="ml-4 whitespace-pre-wrap break-all text-text-muted">
            {JSON.stringify(entry.fields, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}
