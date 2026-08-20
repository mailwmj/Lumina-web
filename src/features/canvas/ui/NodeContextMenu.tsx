import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { UI_POPOVER_TRANSITION_MS } from '@/components/ui/motion';

interface NodeContextMenuProps {
  position: { x: number; y: number };
  canPaste: boolean;
  onCopy: () => void;
  onDuplicate: () => void;
  onPaste: () => void;
  onDelete: () => void;
  onClose: () => void;
}

const MENU_ACTION_CLASS =
  'flex h-10 w-full items-center justify-between gap-4 rounded-[6px] px-3 text-left text-sm font-medium text-text-dark transition-colors hover:bg-[var(--ui-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45';

export function NodeContextMenu({
  position,
  canPaste,
  onCopy,
  onDuplicate,
  onPaste,
  onDelete,
  onClose,
}: NodeContextMenuProps) {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isVisible, setIsVisible] = useState(false);

  const close = useCallback(() => {
    setIsVisible(false);
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
    }
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      onClose();
    }, UI_POPOVER_TRANSITION_MS);
  }, [onClose]);

  const triggerAction = useCallback((action: () => void) => {
    action();
    close();
  }, [close]);

  useEffect(() => {
    const frameId = requestAnimationFrame(() => {
      setIsVisible(true);
      menuRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frameId);
  }, []);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        close();
      }
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [close]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      event.preventDefault();
      close();
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [close]);

  useEffect(() => () => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
    }
  }, []);

  return (
    <div
      ref={menuRef}
      role="menu"
      tabIndex={-1}
      aria-label={t('canvas.nodeContextMenu.label')}
      onContextMenu={(event) => event.preventDefault()}
      className={`absolute z-[60] w-64 overflow-hidden rounded-[10px] border border-[var(--ui-border-soft)] bg-[var(--ui-surface-elevated)] p-1.5 shadow-[var(--ui-shadow-panel)] transition-[opacity,transform] duration-150 ${
        isVisible ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-1 opacity-0'
      }`}
      style={{ left: position.x, top: position.y }}
    >
      <button
        type="button"
        role="menuitem"
        className={MENU_ACTION_CLASS}
        onClick={() => triggerAction(onCopy)}
      >
        <span>{t('common.copy')}</span>
        <kbd className="font-mono text-xs font-medium text-text-muted">{t('canvas.nodeContextMenu.copyShortcut')}</kbd>
      </button>

      <button
        type="button"
        role="menuitem"
        className={MENU_ACTION_CLASS}
        onClick={() => triggerAction(onDuplicate)}
      >
        <span>{t('canvas.nodeContextMenu.duplicate')}</span>
        <span className="text-xs font-normal text-text-muted">{t('canvas.nodeContextMenu.duplicateHint')}</span>
      </button>

      <button
        type="button"
        role="menuitem"
        disabled={!canPaste}
        className={`${MENU_ACTION_CLASS} disabled:cursor-not-allowed disabled:text-text-muted/40 disabled:hover:bg-transparent`}
        onClick={() => triggerAction(onPaste)}
      >
        <span>{t('canvas.nodeContextMenu.paste')}</span>
        <kbd className="font-mono text-xs font-medium text-text-muted/80">{t('canvas.nodeContextMenu.pasteShortcut')}</kbd>
      </button>

      <div className="mx-2 my-1 h-px bg-[var(--ui-border-soft)]" />

      <button
        type="button"
        role="menuitem"
        className={`${MENU_ACTION_CLASS} text-red-400 hover:bg-red-500/10 hover:text-red-300`}
        onClick={() => triggerAction(onDelete)}
      >
        <span>{t('common.delete')}</span>
        <kbd className="font-mono text-xs font-medium text-red-400/75">{t('canvas.nodeContextMenu.deleteShortcut')}</kbd>
      </button>
    </div>
  );
}
