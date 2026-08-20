import { useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { ArrowLeft, Plus, Trash2 } from '@/components/ui/icons';

export interface ProviderListShellProps<TItem> {
  items: TItem[];
  getItemId: (item: TItem) => string;
  getItemTitle: (item: TItem) => string;
  getItemSubtitle?: (item: TItem) => string;
  getItemMeta?: (item: TItem) => string | undefined;
  isBuiltIn?: (item: TItem) => boolean;
  onAdd: () => string;
  onRemove: (id: string) => void;
  onDetailChange?: (isOpen: boolean) => void;
  renderDetail: (item: TItem) => ReactNode;
  addLabel: string;
  removeLabel: string;
  emptyLabel: string;
}

export function ProviderListShell<TItem>({
  items,
  getItemId,
  getItemTitle,
  getItemSubtitle,
  getItemMeta,
  isBuiltIn,
  onAdd,
  onRemove,
  onDetailChange,
  renderDetail,
  addLabel,
  removeLabel,
  emptyLabel,
}: ProviderListShellProps<TItem>) {
  const { t } = useTranslation();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const idSet = useMemo(
    () => new Set(items.map((item) => getItemId(item))),
    [items, getItemId]
  );

  // 选中项被删除或被外部替换时，回到列表态。
  // items 数组每次编辑都会变，但 id 仍在，所以只在 id 真正消失时触发。
  useEffect(() => {
    if (selectedId !== null && !idSet.has(selectedId)) {
      setSelectedId(null);
    }
  }, [selectedId, idSet]);

  const selectedItem = useMemo(() => {
    if (selectedId === null) {
      return null;
    }
    return items.find((item) => getItemId(item) === selectedId) ?? null;
  }, [items, selectedId, getItemId]);

  const showDetail = selectedItem !== null;

  useLayoutEffect(() => {
    onDetailChange?.(showDetail);
  }, [onDetailChange, showDetail]);

  // Esc 键从详情回列表
  useEffect(() => {
    if (!showDetail) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setSelectedId(null);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [showDetail]);

  const handleAdd = () => {
    const newId = onAdd();
    setSelectedId(newId);
  };

  const handleRemove = () => {
    if (selectedId === null) {
      return;
    }
    onRemove(selectedId);
    setSelectedId(null);
  };

  return (
    <div className="relative">
      {/* 列表态 */}
      {!showDetail && (
        <div>
          <div className="flex items-center justify-end gap-3 py-3">
            <button
              type="button"
              onClick={handleAdd}
              className="inline-flex h-8 shrink-0 items-center rounded-md border border-[var(--ui-border-soft)] bg-[var(--ui-surface-field)] px-3 text-xs text-text-dark transition-colors hover:bg-[var(--ui-hover)]"
            >
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              {addLabel}
            </button>
          </div>

          {items.length === 0 ? (
            <div className="py-10 text-center text-sm text-text-muted">{emptyLabel}</div>
          ) : (
            <div className="space-y-2 pb-4">
              {items.map((item) => {
                const id = getItemId(item);
                const title = getItemTitle(item);
                const subtitle = getItemSubtitle?.(item);
                const meta = getItemMeta?.(item);
                const builtIn = isBuiltIn?.(item) ?? false;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setSelectedId(id)}
                    className="flex w-full items-center gap-3 rounded-[8px] border border-[var(--ui-border-soft)] bg-[var(--ui-surface-field)] px-3 py-2.5 text-left transition-colors hover:bg-[var(--ui-hover)]"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-text-dark">{title}</span>
                        {builtIn && (
                          <span className="shrink-0 rounded-full bg-[var(--ui-hover)] px-2 py-0.5 text-[10px] font-medium text-text-muted">
                            {t('settings.providerBuiltIn')}
                          </span>
                        )}
                      </div>
                      {subtitle && (
                        <p className="mt-0.5 truncate text-xs text-text-muted">{subtitle}</p>
                      )}
                    </div>
                    {meta && (
                      <span className="shrink-0 text-xs text-text-muted">{meta}</span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* 详情态 */}
      {showDetail && selectedItem && (
        <div>
          <div className="flex items-center justify-between gap-3 py-3">
            <button
              type="button"
              onClick={() => setSelectedId(null)}
              className="inline-flex h-8 shrink-0 items-center rounded-md px-2 text-xs text-text-muted transition-colors hover:bg-[var(--ui-hover)] hover:text-text-dark"
            >
              <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
              {t('common.back')}
            </button>
            <div className="min-w-0 flex-1 truncate text-center text-sm font-medium text-text-dark">
              {getItemTitle(selectedItem)}
            </div>
            {!(isBuiltIn?.(selectedItem) ?? false) && (
              <button
                type="button"
                aria-label={removeLabel}
                onClick={handleRemove}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-red-500/10 hover:text-red-400"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )}
          </div>
          <div className="pb-4">{renderDetail(selectedItem)}</div>
        </div>
      )}
    </div>
  );
}
