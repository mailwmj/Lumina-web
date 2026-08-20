import { memo, type CSSProperties } from 'react';
import { useViewport } from '@xyflow/react';

interface CanvasGridBackgroundProps {
  gap: number;
}

interface CanvasGridPattern {
  size: number;
  x: number;
  y: number;
}

type CanvasGridStyle = CSSProperties & {
  '--canvas-grid-size': string;
  '--canvas-grid-x': string;
  '--canvas-grid-y': string;
};

function normalizeOffset(offset: number, size: number): number {
  return ((offset % size) + size) % size;
}

export function resolveCanvasGridPattern(
  gap: number,
  x: number,
  y: number,
  zoom: number
): CanvasGridPattern {
  const scaledSize = gap * zoom;
  const size = Number.isFinite(scaledSize) && scaledSize > 0 ? scaledSize : 1;

  return {
    size,
    x: normalizeOffset(x, size),
    y: normalizeOffset(y, size),
  };
}

export const CanvasGridBackground = memo(({ gap }: CanvasGridBackgroundProps) => {
  const { x, y, zoom } = useViewport();
  const pattern = resolveCanvasGridPattern(gap, x, y, zoom);
  const style: CanvasGridStyle = {
    '--canvas-grid-size': `${pattern.size}px`,
    '--canvas-grid-x': `${pattern.x}px`,
    '--canvas-grid-y': `${pattern.y}px`,
  };

  return <div className="canvas-grid-background" style={style} aria-hidden="true" />;
});

CanvasGridBackground.displayName = 'CanvasGridBackground';
