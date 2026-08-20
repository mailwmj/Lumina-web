import { useMemo, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Image, Upload, Sparkles, LayoutGrid, Type, Video } from '@/components/ui/icons';
import { UI_POPOVER_TRANSITION_MS } from '@/components/ui/motion';

import type { CanvasNodeType } from '@/features/canvas/domain/canvasNodes';
import { nodeCatalog } from '@/features/canvas/application/nodeCatalog';
import type { MenuIconKey } from '@/features/canvas/domain/nodeRegistry';

interface NodeSelectionMenuProps {
  position: { x: number; y: number };
  allowedTypes?: CanvasNodeType[];
  onSelect: (type: CanvasNodeType) => void;
  onClose: () => void;
}

const iconMap: Record<MenuIconKey, typeof Upload> = {
  upload: Upload,
  sparkles: Sparkles,
  layout: LayoutGrid,
  text: Type,
  video: Video,
};

export function NodeSelectionMenu({
  position,
  allowedTypes,
  onSelect,
  onClose,
}: NodeSelectionMenuProps) {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(false);

  // Double-column layout for double-click menu (no allowedTypes filter),
  // single-column for drag-connect menu (with allowedTypes filter)
  const isDoubleColumn = !allowedTypes;

  const allowedTypeSet = useMemo(
    () => (allowedTypes ? new Set(allowedTypes) : null),
    [allowedTypes]
  );

  const menuItems = useMemo(() => {
    const candidates = !allowedTypeSet || !allowedTypes
      ? nodeCatalog.getMenuDefinitions()
      : Array.from(new Set(allowedTypes)).map((type) => nodeCatalog.getDefinition(type));

    const dedupedByLabel = new Map<string, (typeof candidates)[number]>();
    for (const definition of candidates) {
      const existing = dedupedByLabel.get(definition.menuLabelKey);
      if (!existing) {
        dedupedByLabel.set(definition.menuLabelKey, definition);
        continue;
      }

      // Prefer user-visible definitions when multiple internal node types share the same label.
      if (!existing.visibleInMenu && definition.visibleInMenu) {
        dedupedByLabel.set(definition.menuLabelKey, definition);
      }
    }

    return Array.from(dedupedByLabel.values());
  }, [allowedTypeSet, allowedTypes]);

  // Split items into two columns for double-column layout
  const halfLength = Math.ceil(menuItems.length / 2);
  const leftColumnItems = isDoubleColumn ? menuItems.slice(0, halfLength) : menuItems;
  const rightColumnItems = isDoubleColumn ? menuItems.slice(halfLength) : [];

  useEffect(() => {
    requestAnimationFrame(() => {
      setIsVisible(true);
    });
  }, []);

  const handleClose = useCallback(() => {
    setIsVisible(false);
    setTimeout(onClose, UI_POPOVER_TRANSITION_MS);
  }, [onClose]);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) {
        return;
      }

      handleClose();
    };

    document.addEventListener('mousedown', onPointerDown, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true);
    };
  }, [handleClose]);

  return (
    <div
      ref={menuRef}
      className={`
        absolute z-50 overflow-hidden rounded-[10px] border border-[var(--ui-border-soft)] bg-[var(--ui-surface-elevated)] p-1 shadow-[var(--ui-shadow-panel)]
        transition-opacity duration-150
        ${isVisible ? 'opacity-100' : 'opacity-0'}
      `}
      style={{ left: position.x, top: position.y, minWidth: isDoubleColumn ? 360 : 220 }}
    >
      <div className={`flex ${isDoubleColumn ? '' : ''}`}>
        {/* Left column or single column */}
        <div className={`flex-1 ${isDoubleColumn ? '' : ''}`}>
          {leftColumnItems.map((item, index) => {
            const Icon = iconMap[item.menuIcon] ?? Image;
            return (
              <button
                key={item.type}
                className="flex h-11 w-full items-center gap-2.5 rounded-md px-2.5 text-left transition-colors hover:bg-[var(--ui-hover)]"
                style={{ transitionDelay: isVisible ? `${index * 30}ms` : '0ms' }}
                onClick={() => {
                  handleClose();
                  setTimeout(() => onSelect(item.type), UI_POPOVER_TRANSITION_MS + 10);
                }}
              >
                <div className="flex h-7 w-7 items-center justify-center rounded-md bg-accent/10">
                  <Icon className="h-4 w-4 text-accent" />
                </div>
                <span className="text-sm text-text-dark">{t(item.menuLabelKey)}</span>
              </button>
            );
          })}
        </div>
        {/* Right column - only for double column layout */}
        {isDoubleColumn && rightColumnItems.length > 0 && (
                  <div className="flex-1 border-l border-[var(--ui-border-soft)] pl-1">
            {rightColumnItems.map((item, index) => {
              const Icon = iconMap[item.menuIcon] ?? Image;
              return (
                <button
                  key={item.type}
                  className="flex h-11 w-full items-center gap-2.5 rounded-md px-2.5 text-left transition-colors hover:bg-[var(--ui-hover)]"
                  style={{ transitionDelay: isVisible ? `${(halfLength + index) * 30}ms` : '0ms' }}
                  onClick={() => {
                    handleClose();
                    setTimeout(() => onSelect(item.type), UI_POPOVER_TRANSITION_MS + 10);
                  }}
                >
                  <div className="flex h-7 w-7 items-center justify-center rounded-md bg-accent/10">
                    <Icon className="h-4 w-4 text-accent" />
                  </div>
                  <span className="text-sm text-text-dark">{t(item.menuLabelKey)}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
