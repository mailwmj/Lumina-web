import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { Viewport } from '@xyflow/react';
import { useTranslation } from 'react-i18next';
import { UiTooltip } from '@/components/ui';

import type { CanvasNode } from '../domain/canvasNodes';

interface Point {
  x: number;
  y: number;
}

interface SourceAnchor extends Point {
  nodeId: string;
}

interface SelectionGeometry {
  connector: Point;
  sourceAnchors: SourceAnchor[];
}

interface DragPreview {
  end: Point;
  sourceAnchors: SourceAnchor[];
}

interface MultiSelectionConnectorProps {
  enabled: boolean;
  nodes: CanvasNode[];
  selectedNodeIds: string[];
  sourceNodeIds: string[];
  viewport: Viewport;
  wrapperRef: RefObject<HTMLDivElement | null>;
  onConnectEnd: (
    sourceNodeIds: string[],
    clientPosition: Point,
    explicitTargetHandle?: string
  ) => void;
}

function createPreviewPath(start: Point, end: Point): string {
  const deltaX = end.x - start.x;
  const curveStrength = Math.max(36, Math.min(160, Math.abs(deltaX) * 0.42));
  const direction = deltaX >= 0 ? 1 : -1;
  return `M ${start.x} ${start.y} C ${start.x + direction * curveStrength} ${start.y}, ${end.x - direction * curveStrength} ${end.y}, ${end.x} ${end.y}`;
}

export const MultiSelectionConnector = memo(({
  enabled,
  nodes,
  selectedNodeIds,
  sourceNodeIds,
  viewport,
  wrapperRef,
  onConnectEnd,
}: MultiSelectionConnectorProps) => {
  const { t } = useTranslation();
  const [geometry, setGeometry] = useState<SelectionGeometry | null>(null);
  const [preview, setPreview] = useState<DragPreview | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    sourceNodeIds: string[];
    sourceAnchors: SourceAnchor[];
  } | null>(null);

  const selectedKey = selectedNodeIds.join('|');
  const sourceKey = sourceNodeIds.join('|');

  const measureGeometry = useCallback((): SelectionGeometry | null => {
    const wrapper = wrapperRef.current;
    if (!wrapper || selectedNodeIds.length < 2 || sourceNodeIds.length < 2) {
      return null;
    }

    const wrapperRect = wrapper.getBoundingClientRect();
    const nodeElements = Array.from(
      wrapper.querySelectorAll<HTMLElement>('.react-flow__node[data-id]')
    );
    const nodeElementById = new Map(
      nodeElements
        .map((element) => [element.dataset.id, element] as const)
        .filter((entry): entry is [string, HTMLElement] => Boolean(entry[0]))
    );
    const selectedRects = selectedNodeIds
      .map((nodeId) => nodeElementById.get(nodeId)?.getBoundingClientRect())
      .filter((rect): rect is DOMRect => Boolean(rect));

    if (selectedRects.length === 0) {
      return null;
    }

    const right = Math.max(...selectedRects.map((rect) => rect.right));
    const top = Math.min(...selectedRects.map((rect) => rect.top));
    const bottom = Math.max(...selectedRects.map((rect) => rect.bottom));
    const sourceAnchors = sourceNodeIds.flatMap((nodeId) => {
      const nodeElement = nodeElementById.get(nodeId);
      if (!nodeElement) {
        return [];
      }
      const nodeRect = nodeElement.getBoundingClientRect();
      const sourceHandle = nodeElement.querySelector<HTMLElement>('.react-flow__handle.source');
      const handleRect = sourceHandle?.getBoundingClientRect();
      return [{
        nodeId,
        x: (handleRect ? handleRect.left + handleRect.width / 2 : nodeRect.right) - wrapperRect.left,
        y: (handleRect ? handleRect.top + handleRect.height / 2 : nodeRect.top + nodeRect.height / 2) - wrapperRect.top,
      }];
    });

    if (sourceAnchors.length < 2) {
      return null;
    }

    return {
      connector: {
        // Center the handle on the selection outline instead of leaving it
        // floating in the empty space beside the selected nodes.
        x: right - wrapperRect.left,
        y: (top + bottom) / 2 - wrapperRect.top,
      },
      sourceAnchors,
    };
  }, [selectedNodeIds, sourceNodeIds, wrapperRef]);

  useEffect(() => {
    if (!enabled) {
      setGeometry(null);
      setPreview(null);
      dragRef.current = null;
      return;
    }

    const frameId = requestAnimationFrame(() => {
      setGeometry(measureGeometry());
    });
    return () => cancelAnimationFrame(frameId);
  }, [enabled, measureGeometry, nodes, selectedKey, sourceKey, viewport.x, viewport.y, viewport.zoom]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      const wrapper = wrapperRef.current;
      if (!drag || !wrapper || drag.pointerId !== event.pointerId) {
        return;
      }
      const wrapperRect = wrapper.getBoundingClientRect();
      setPreview({
        sourceAnchors: drag.sourceAnchors,
        end: {
          x: event.clientX - wrapperRect.left,
          y: event.clientY - wrapperRect.top,
        },
      });
    };

    const completeDrag = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) {
        return;
      }
      dragRef.current = null;
      setPreview(null);

      const targetHandle = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>('.react-flow__handle.target')
        ?.dataset.handleid;
      onConnectEnd(
        drag.sourceNodeIds,
        { x: event.clientX, y: event.clientY },
        targetHandle
      );
    };

    const cancelDrag = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) {
        return;
      }
      dragRef.current = null;
      setPreview(null);
    };

    window.addEventListener('pointermove', handlePointerMove, true);
    window.addEventListener('pointerup', completeDrag, true);
    window.addEventListener('pointercancel', cancelDrag, true);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove, true);
      window.removeEventListener('pointerup', completeDrag, true);
      window.removeEventListener('pointercancel', cancelDrag, true);
    };
  }, [onConnectEnd, wrapperRef]);

  const paths = useMemo(
    () => preview?.sourceAnchors.map((source) => ({
      nodeId: source.nodeId,
      d: createPreviewPath(source, preview.end),
    })) ?? [],
    [preview]
  );

  if (!enabled || !geometry) {
    return null;
  }

  return (
    <>
      {preview && (
        <svg className="pointer-events-none absolute inset-0 z-40 h-full w-full overflow-visible">
          {paths.map((path) => (
            <path
              key={path.nodeId}
              d={path.d}
              fill="none"
              stroke="var(--canvas-selection-accent)"
              strokeWidth={3}
              strokeDasharray="10 7"
              strokeLinecap="round"
            />
          ))}
        </svg>
      )}

      <UiTooltip content={t('canvas.multiConnect.dragHandle')}>
        <button
          type="button"
          className="nodrag nopan absolute z-50 flex h-8 w-8 -translate-x-1/2 -translate-y-1/2 cursor-crosshair items-center justify-center rounded-full bg-transparent"
          style={{ left: geometry.connector.x, top: geometry.connector.y }}
          aria-label={t('canvas.multiConnect.dragHandle')}
          onPointerDown={(event) => {
          if (event.button !== 0) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          const nextGeometry = measureGeometry();
          if (!nextGeometry) {
            return;
          }
          dragRef.current = {
            pointerId: event.pointerId,
            sourceNodeIds: [...sourceNodeIds],
            sourceAnchors: nextGeometry.sourceAnchors,
          };
          const wrapperRect = wrapperRef.current?.getBoundingClientRect();
          if (wrapperRect) {
            setPreview({
              sourceAnchors: nextGeometry.sourceAnchors,
              end: {
                x: event.clientX - wrapperRect.left,
                y: event.clientY - wrapperRect.top,
              },
            });
          }
          }}
        >
          <span className="canvas-connection-handle rounded-full" />
        </button>
      </UiTooltip>
    </>
  );
});

MultiSelectionConnector.displayName = 'MultiSelectionConnector';
