import type { PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight } from '@/components/ui/icons';
import { UiTooltip } from '@/components/ui';
import type {
  FixedCanvasStretchOperation,
  NormalizedCanvasRect,
} from './domain';
import { resolveStretchDestination } from './domain';
import type { FixedCanvasCorner } from './BatchFixedCanvasSelection';

const HANDLE_POSITION: Record<FixedCanvasCorner, string> = {
  nw: '-left-1.5 -top-1.5 cursor-nwse-resize',
  ne: '-right-1.5 -top-1.5 cursor-nesw-resize',
  sw: '-bottom-1.5 -left-1.5 cursor-nesw-resize',
  se: '-bottom-1.5 -right-1.5 cursor-nwse-resize',
};

export function BatchFixedCanvasTransformFrame({
  imageBox,
  active,
  label,
  onMoveStart,
  onScaleStart,
}: {
  imageBox: NormalizedCanvasRect;
  active: boolean;
  label: string;
  onMoveStart: (event: ReactPointerEvent) => void;
  onScaleStart: (event: ReactPointerEvent, corner: FixedCanvasCorner) => void;
}) {
  return (
    <div
      data-testid="fixed-canvas-transform-frame"
      className={`group absolute z-[6] border shadow-[0_0_0_1px_rgba(255,255,255,0.58)] transition-colors ${
        active ? 'border-accent' : 'border-zinc-950/75 hover:border-accent'
      }`}
      style={{
        left: `${imageBox.x}%`,
        top: `${imageBox.y}%`,
        width: `${imageBox.width}%`,
        height: `${imageBox.height}%`,
        touchAction: 'none',
      }}
      onPointerDown={onMoveStart}
    >
      {(['nw', 'ne', 'sw', 'se'] as const).map((corner) => (
        <button
          key={corner}
          type="button"
          aria-label={label}
          title={label}
          className={`absolute z-[7] h-3 w-3 rounded-[2px] border border-zinc-950 bg-white shadow-[0_0_0_1px_rgba(255,255,255,0.75)] transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/55 ${HANDLE_POSITION[corner]}`}
          onPointerDown={(event) => onScaleStart(event, corner)}
        />
      ))}
    </div>
  );
}

export function BatchFixedCanvasStretchPatch({
  operation,
  imageSource,
  imageBox,
  active,
  live,
  label,
  onSelect,
}: {
  operation: FixedCanvasStretchOperation;
  imageSource: string;
  imageBox: NormalizedCanvasRect;
  active: boolean;
  live?: boolean;
  label: string;
  onSelect?: () => void;
}) {
  const destination = resolveStretchDestination(operation);

  return (
    <button
      type="button"
      aria-label={label}
      tabIndex={live || !onSelect ? -1 : 0}
      className={`absolute z-[2] overflow-hidden p-0 ${live || !onSelect ? 'pointer-events-none' : ''} ${
        active ? 'outline outline-1 outline-accent' : live ? 'outline outline-1 outline-accent/75' : ''
      }`}
      style={{
        left: `${destination.x}%`,
        top: `${destination.y}%`,
        width: `${destination.width}%`,
        height: `${destination.height}%`,
      }}
      onPointerDown={onSelect ? (event) => event.stopPropagation() : undefined}
      onClick={onSelect}
    >
      <img
        src={imageSource}
        alt=""
        draggable={false}
        className="pointer-events-none absolute max-h-none max-w-none select-none"
        style={{
          left: `${-((operation.source.x - imageBox.x) / operation.source.width) * 100}%`,
          top: `${-((operation.source.y - imageBox.y) / operation.source.height) * 100}%`,
          width: `${(imageBox.width / operation.source.width) * 100}%`,
          height: `${(imageBox.height / operation.source.height) * 100}%`,
        }}
      />
    </button>
  );
}

export function BatchFixedCanvasNavigation({
  index,
  total,
  onPrevious,
  onNext,
}: {
  index: number;
  total: number;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2">
      <UiTooltip content={t('viewer.prev')}>
        <button
          type="button"
          aria-label={t('viewer.prev')}
          disabled={index <= 0}
          onClick={onPrevious}
          className="flex h-8 w-8 items-center justify-center rounded-md text-text-muted hover:bg-[var(--ui-hover)] hover:text-text-dark disabled:opacity-35"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
      </UiTooltip>
      <span className="w-14 text-center font-mono text-[11px] text-text-muted">{index + 1}/{total}</span>
      <UiTooltip content={t('viewer.next')}>
        <button
          type="button"
          aria-label={t('viewer.next')}
          disabled={index >= total - 1}
          onClick={onNext}
          className="flex h-8 w-8 items-center justify-center rounded-md text-text-muted hover:bg-[var(--ui-hover)] hover:text-text-dark disabled:opacity-35"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </UiTooltip>
    </div>
  );
}
