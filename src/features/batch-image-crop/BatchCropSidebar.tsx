import { useRef, type DragEvent, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Crop, Loader2, Plus, Trash2 } from '@/components/ui/icons';
import { UiButton, UiTooltip } from '@/components/ui';
import {
  BATCH_CROP_MAX_IMAGES,
  BATCH_CROP_TARGETS,
  formatBatchCropFileSize,
  type BatchCropImageItem,
  type BatchCropItemStatus,
  type BatchCropTargetId,
} from './domain';
import { resolveBatchCropDisplayUrl } from './infrastructure/tauriBatchImageCropGateway';

type BatchCropPhase = 'idle' | 'preparing' | 'planning' | 'exporting';

interface BatchCropSidebarProps {
  targetId: BatchCropTargetId | null;
  items: BatchCropImageItem[];
  selectedId: string | null;
  filter: 'all' | 'review';
  phase: BatchCropPhase;
  progress: number;
  progressTotal: number;
  primaryLabel: string;
  primaryDisabled: boolean;
  targetChangeDisabled: boolean;
  onTargetChange: (targetId: BatchCropTargetId) => void;
  onSelectItem: (itemId: string) => void;
  onFilterChange: (filter: 'all' | 'review') => void;
  onAddPaths: (paths: string[]) => void;
  onChooseImages: () => void;
  onRemoveItem: (itemId: string) => void;
  onPrimaryAction: () => void;
}

const STATUS_KEYS: Record<BatchCropItemStatus, string> = {
  pending: 'batchCrop.status.pending',
  processing: 'batchCrop.status.processing',
  auto: 'batchCrop.status.auto',
  review: 'batchCrop.status.review',
  adjusted: 'batchCrop.status.adjusted',
  confirmed: 'batchCrop.status.confirmed',
  fixedCompose: 'batchCrop.status.fixedCompose',
  fixedFill: 'batchCrop.status.fixedFill',
  fixedReady: 'batchCrop.status.fixedReady',
  aiProcessing: 'batchCrop.status.aiProcessing',
  aiGenerated: 'batchCrop.status.aiGenerated',
  aiFailed: 'batchCrop.status.aiFailed',
  exporting: 'batchCrop.status.exporting',
  exported: 'batchCrop.status.exported',
  error: 'batchCrop.status.error',
};

function resolveDroppedPaths(event: DragEvent<HTMLElement>): string[] {
  return Array.from(event.dataTransfer.files ?? [])
    .map((file) => (file as File & { path?: string }).path ?? '')
    .filter(Boolean);
}

export function BatchCropSidebar({
  targetId,
  items,
  selectedId,
  filter,
  phase,
  progress,
  progressTotal,
  primaryLabel,
  primaryDisabled,
  targetChangeDisabled,
  onTargetChange,
  onSelectItem,
  onFilterChange,
  onAddPaths,
  onChooseImages,
  onRemoveItem,
  onPrimaryAction,
}: BatchCropSidebarProps) {
  const { t } = useTranslation();
  const itemRefs = useRef(new Map<string, HTMLDivElement>());
  const busy = phase !== 'idle';
  const reviewCount = items.filter((item) => item.compositionMode === 'crop' && item.cropStatus === 'review').length;
  const visibleItems = filter === 'review'
    ? items.filter((item) => item.compositionMode === 'crop' && item.cropStatus === 'review')
    : items;

  const handleDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    if (busy) return;
    const paths = resolveDroppedPaths(event);
    if (paths.length > 0) onAddPaths(paths);
  };

  const handleItemKeyDown = (event: KeyboardEvent<HTMLDivElement>, itemId: string) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelectItem(itemId);
      return;
    }
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const currentIndex = visibleItems.findIndex((item) => item.id === itemId);
    const nextIndex = event.key === 'ArrowUp' ? currentIndex - 1 : currentIndex + 1;
    const nextItem = visibleItems[nextIndex];
    if (!nextItem) return;
    onSelectItem(nextItem.id);
    const nextRow = itemRefs.current.get(nextItem.id);
    nextRow?.focus();
    nextRow?.scrollIntoView?.({ block: 'nearest' });
  };

  return (
    <aside className="flex h-full min-h-0 w-[304px] min-w-[272px] flex-col border-r border-[var(--ui-border-soft)] bg-[var(--ui-surface-panel)]">
      <div className="border-b border-[var(--ui-border-soft)] p-4">
        <div className="mb-2 text-xs font-medium text-text-muted">{t('batchCrop.targetSize')}</div>
        <div className="grid grid-cols-3 gap-1 rounded-lg bg-[var(--ui-surface-field)] p-1">
          {BATCH_CROP_TARGETS.map((target) => (
            <button
              key={target.id}
              type="button"
              disabled={busy || targetChangeDisabled}
              onClick={() => onTargetChange(target.id)}
              className={`h-8 rounded-md text-[11px] font-medium transition-colors ${
                targetId === target.id
                  ? 'bg-[var(--ui-surface-elevated)] text-text-dark shadow-[0_0_0_1px_var(--ui-border-strong)]'
                  : 'text-text-muted hover:bg-[var(--ui-hover)] hover:text-text-dark'
              } disabled:cursor-not-allowed disabled:opacity-45`}
            >
              {target.width}×{target.height}
            </button>
          ))}
        </div>
      </div>

      <div
        className="border-b border-[var(--ui-border-soft)] p-3"
        onDragOver={(event) => event.preventDefault()}
        onDrop={handleDrop}
      >
        <UiButton
          type="button"
          onClick={onChooseImages}
          disabled={!targetId || busy || items.length >= BATCH_CROP_MAX_IMAGES}
          className="w-full gap-2"
        >
          <Plus className="h-4 w-4" />
          {t('batchCrop.addImages')}
        </UiButton>
      </div>

      <div className="flex h-10 items-center justify-between border-b border-[var(--ui-border-soft)] px-3">
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => onFilterChange('all')}
            className={`rounded-md px-2 py-1 text-xs ${filter === 'all' ? 'bg-[var(--ui-hover)] text-text-dark' : 'text-text-muted'}`}
          >
            {t('batchCrop.filterAll')}
          </button>
          <button
            type="button"
            onClick={() => onFilterChange('review')}
            className={`rounded-md px-2 py-1 text-xs ${filter === 'review' ? 'bg-amber-500/12 text-amber-500' : 'text-text-muted'}`}
          >
            {t('batchCrop.filterReview')} {reviewCount || ''}
          </button>
        </div>
        <span className="font-mono text-[11px] text-text-muted">{items.length}/{BATCH_CROP_MAX_IMAGES}</span>
      </div>

      <div className="ui-scrollbar-y min-h-0 flex-1 overflow-y-auto py-1">
        {visibleItems.map((item) => (
          <div
            key={item.id}
            ref={(element) => {
              if (element) itemRefs.current.set(item.id, element);
              else itemRefs.current.delete(item.id);
            }}
            role="button"
            tabIndex={0}
            onClick={() => onSelectItem(item.id)}
            onKeyDown={(event) => handleItemKeyDown(event, item.id)}
            className={`group flex h-[66px] w-full items-center gap-2 border-l-2 px-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/45 ${
              selectedId === item.id
                ? 'border-l-accent bg-[var(--ui-hover)]'
                : 'border-l-transparent hover:bg-[var(--ui-hover)]'
            }`}
          >
            <img
              src={resolveBatchCropDisplayUrl(item.thumbnailPath)}
              alt=""
              loading="lazy"
              className="h-12 w-12 shrink-0 rounded-md bg-[var(--ui-surface-field)] object-cover"
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium text-text-dark">{item.fileName}</span>
              <span className="mt-1 block font-mono text-[11px] text-text-muted">
                {t(`batchCrop.mode.${item.compositionMode}`)} · {formatBatchCropFileSize(item.fileSize)}
              </span>
            </span>
            {item.status === 'aiProcessing' || item.status === 'aiGenerated' || item.status === 'aiFailed' ? (
              <span
                className={`shrink-0 whitespace-nowrap rounded px-1.5 py-1 text-[10px] font-medium leading-none ${
                  item.status === 'aiProcessing'
                    ? 'bg-cyan-500/12 text-cyan-500'
                    : item.status === 'aiGenerated'
                      ? 'bg-emerald-500/12 text-emerald-500'
                      : 'bg-red-500/12 text-red-500'
                }`}
              >
                {t(STATUS_KEYS[item.status])}
              </span>
            ) : (
              <UiTooltip content={item.errorMessage || t(STATUS_KEYS[item.status])}>
                <span
                  aria-label={t(STATUS_KEYS[item.status])}
                  className={`h-2 w-2 shrink-0 rounded-full ${
                    item.status === 'review'
                      ? 'bg-amber-500'
                      : item.status === 'error'
                        ? 'bg-red-500'
                        : item.status === 'exported'
                          ? 'bg-emerald-500'
                          : item.status === 'processing' || item.status === 'exporting'
                            ? 'animate-pulse bg-accent'
                            : item.status === 'pending'
                              ? 'bg-zinc-500'
                              : 'bg-accent'
                  }`}
                >
                </span>
              </UiTooltip>
            )}
            {!busy && item.status !== 'aiProcessing' && item.status !== 'exporting' && (
              <UiTooltip content={t('batchCrop.removeImage')}>
                <span
                  role="button"
                  tabIndex={0}
                  aria-label={t('batchCrop.removeImage')}
                  onClick={(event) => {
                    event.stopPropagation();
                    onRemoveItem(item.id);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onRemoveItem(item.id);
                    }
                  }}
                  className="hidden h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-red-500/10 hover:text-red-500 group-hover:flex"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </span>
              </UiTooltip>
            )}
          </div>
        ))}
      </div>

      <div className="border-t border-[var(--ui-border-soft)] p-3">
        {busy && (
          <div className="mb-3">
            <div className="mb-1.5 flex items-center justify-between text-[11px] text-text-muted">
              <span>{t(`batchCrop.phase.${phase}`)}</span>
              <span className="font-mono">{progress}/{progressTotal}</span>
            </div>
            <div className="h-1 overflow-hidden rounded-full bg-[var(--ui-surface-field)]">
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-200"
                style={{ width: `${progressTotal ? (progress / progressTotal) * 100 : 0}%` }}
              />
            </div>
          </div>
        )}
        <UiButton
          type="button"
          variant="primary"
          onClick={onPrimaryAction}
          disabled={primaryDisabled}
          className="w-full gap-2"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Crop className="h-4 w-4" />}
          {primaryLabel}
        </UiButton>
      </div>
    </aside>
  );
}
