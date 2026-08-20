import { useEffect } from 'react';
import { useLogStore } from './store';

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  return false;
}

export function useLogPanelHotkey(): void {
  const toggleOpen = useLogStore((s) => s.toggleOpen);

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (isEditableTarget(e.target)) return;
      const isMod = e.ctrlKey || e.metaKey;
      if (isMod && e.shiftKey && (e.key === 'L' || e.key === 'l')) {
        e.preventDefault();
        toggleOpen();
      }
    }
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [toggleOpen]);
}