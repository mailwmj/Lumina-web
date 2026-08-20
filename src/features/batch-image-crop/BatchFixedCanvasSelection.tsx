import type { PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  FixedCanvasStretchDirection,
  NormalizedCanvasRect,
} from './domain';

export type FixedCanvasCorner = 'nw' | 'ne' | 'sw' | 'se';

interface BatchFixedCanvasSelectionProps {
  selection: NormalizedCanvasRect;
  availableDirections: Record<FixedCanvasStretchDirection, boolean>;
  onMoveStart: (event: ReactPointerEvent) => void;
  onResizeStart: (event: ReactPointerEvent, corner: FixedCanvasCorner) => void;
  onStretchStart: (
    event: ReactPointerEvent,
    direction: FixedCanvasStretchDirection
  ) => void;
}

const CORNER_POSITION: Record<FixedCanvasCorner, string> = {
  nw: '-left-1.5 -top-1.5 cursor-nwse-resize',
  ne: '-right-1.5 -top-1.5 cursor-nesw-resize',
  sw: '-bottom-1.5 -left-1.5 cursor-nesw-resize',
  se: '-bottom-1.5 -right-1.5 cursor-nwse-resize',
};

export function BatchFixedCanvasSelection({
  selection,
  availableDirections,
  onMoveStart,
  onResizeStart,
  onStretchStart,
}: BatchFixedCanvasSelectionProps) {
  const { t } = useTranslation();

  return (
    <div
      data-testid="fixed-canvas-selection"
      className="absolute z-[7] cursor-move border border-dashed border-zinc-950 bg-accent/10 shadow-[0_0_0_1px_rgba(255,255,255,0.65)]"
      style={{
        left: `${selection.x}%`,
        top: `${selection.y}%`,
        width: `${selection.width}%`,
        height: `${selection.height}%`,
        touchAction: 'none',
      }}
      onPointerDown={onMoveStart}
    >
      {(['nw', 'ne', 'sw', 'se'] as const).map((corner) => (
        <button
          key={corner}
          type="button"
          aria-label={t('batchCrop.fixed.resizeSelection')}
          className={`absolute z-[8] h-3 w-3 rounded-[2px] border border-zinc-950 bg-accent shadow-[0_0_0_1px_rgba(255,255,255,0.75)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/55 ${CORNER_POSITION[corner]}`}
          onPointerDown={(event) => onResizeStart(event, corner)}
        />
      ))}

      {availableDirections.left && (
        <button
          type="button"
          aria-label={t('batchCrop.fixed.stretchLeft')}
          className="absolute -left-2 top-1/2 h-6 w-3 -translate-y-1/2 cursor-ew-resize rounded-[3px] border-2 border-zinc-950 bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/55"
          onPointerDown={(event) => onStretchStart(event, 'left')}
        />
      )}
      {availableDirections.right && (
        <button
          type="button"
          aria-label={t('batchCrop.fixed.stretchRight')}
          className="absolute -right-2 top-1/2 h-6 w-3 -translate-y-1/2 cursor-ew-resize rounded-[3px] border-2 border-zinc-950 bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/55"
          onPointerDown={(event) => onStretchStart(event, 'right')}
        />
      )}
      {availableDirections.top && (
        <button
          type="button"
          aria-label={t('batchCrop.fixed.stretchTop')}
          className="absolute -top-2 left-1/2 h-3 w-6 -translate-x-1/2 cursor-ns-resize rounded-[3px] border-2 border-zinc-950 bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/55"
          onPointerDown={(event) => onStretchStart(event, 'top')}
        />
      )}
      {availableDirections.bottom && (
        <button
          type="button"
          aria-label={t('batchCrop.fixed.stretchBottom')}
          className="absolute -bottom-2 left-1/2 h-3 w-6 -translate-x-1/2 cursor-ns-resize rounded-[3px] border-2 border-zinc-950 bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/55"
          onPointerDown={(event) => onStretchStart(event, 'bottom')}
        />
      )}
    </div>
  );
}
