import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { CancelCircleIcon } from '@hugeicons/core-free-icons';
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  Position,
  type EdgeProps,
} from '@xyflow/react';

import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { buildOrthogonalRoute } from './edgeRouting';
import { UiIcon, UiTooltip } from '@/components/ui';

export const DisconnectableEdge = memo(function DisconnectableEdge(props: EdgeProps) {
  const {
    id,
    source,
    target,
    selected,
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    markerEnd,
    style,
  } = props;
  const { t } = useTranslation();
  const deleteEdge = useCanvasStore((state) => state.deleteEdge);
  const nodes = useCanvasStore((state) => state.nodes);
  const canvasEdgeRoutingMode = useSettingsStore((state) => state.canvasEdgeRoutingMode);

  const { edgePath, labelX, labelY } = useMemo(() => {
    if (canvasEdgeRoutingMode === 'spline') {
      const [path, nextLabelX, nextLabelY] = getBezierPath({
        sourceX,
        sourceY,
        sourcePosition,
        targetX,
        targetY,
        targetPosition,
      });
      return {
        edgePath: path,
        labelX: nextLabelX,
        labelY: nextLabelY,
      };
    }

    const route = buildOrthogonalRoute({
      sourceId: source,
      targetId: target,
      sourceX,
      sourceY,
      sourcePosition: sourcePosition ?? Position.Right,
      targetX,
      targetY,
      targetPosition: targetPosition ?? Position.Left,
      nodes,
      smartAvoidance: canvasEdgeRoutingMode === 'smartOrthogonal',
    });
    return {
      edgePath: route.path,
      labelX: route.labelX,
      labelY: route.labelY,
    };
  }, [
    canvasEdgeRoutingMode,
    nodes,
    source,
    sourcePosition,
    sourceX,
    sourceY,
    target,
    targetPosition,
    targetX,
    targetY,
  ]);

  const isProcessingEdge = useMemo(() => {
    const sourceNode = nodes.find((node) => node.id === source);
    const targetNode = nodes.find((node) => node.id === target);

    if (!sourceNode || !targetNode || targetNode.type !== CANVAS_NODE_TYPES.exportImage) {
      return false;
    }

    const isSupportedSource =
      sourceNode.type === CANVAS_NODE_TYPES.storyboardGen ||
      sourceNode.type === CANVAS_NODE_TYPES.imageEdit;
    if (!isSupportedSource) {
      return false;
    }

    const isTargetGenerating =
      (targetNode.data as { isGenerating?: boolean } | undefined)?.isGenerating === true;

    return isTargetGenerating;
  }, [nodes, source, target]);

  const isConnectedToSelectedNode = useMemo(() => {
    const sourceNode = nodes.find((node) => node.id === source);
    const targetNode = nodes.find((node) => node.id === target);
    return (sourceNode?.selected || targetNode?.selected) ?? false;
  }, [nodes, source, target]);

  const edgeStroke = 'rgb(var(--edge-rgb) / 0.68)';
  const processingStroke = 'rgb(var(--edge-rgb) / 0.84)';
  const processingDashStroke = 'rgb(var(--edge-rgb) / 1)';
  const baseStrokeWidth = isProcessingEdge
    ? (selected ? 2.7 : 2.2)
    : (selected ? 2.4 : 1.9);

  return (
    <>
      {isProcessingEdge && (
        <path
          d={edgePath}
          fill="none"
          stroke={processingDashStroke}
          strokeWidth={selected ? 2.5 : 2.1}
          strokeLinecap="round"
          strokeDasharray="8 10"
          className="canvas-processing-edge__flow"
          style={{ pointerEvents: 'none' }}
        />
      )}
      {isConnectedToSelectedNode && !isProcessingEdge && (
        <path
          d={edgePath}
          fill="none"
          stroke="rgb(var(--edge-rgb) / 0.96)"
          strokeWidth={selected ? 2.5 : 2.1}
          strokeLinecap="round"
          strokeDasharray="6 4"
          className="canvas-selected-edge__flow"
          style={{ pointerEvents: 'none' }}
        />
      )}
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          ...style,
          stroke: isProcessingEdge ? processingStroke : edgeStroke,
          strokeWidth: baseStrokeWidth,
          strokeDasharray: isProcessingEdge ? '8 10' : '5 7',
          strokeLinecap: 'round',
        }}
      />
      {selected && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan absolute"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: 'all',
            }}
          >
            <UiTooltip content={t('canvas.disconnectEdge')}>
              <button
                type="button"
                className="flex h-7 w-7 items-center justify-center rounded-full border border-[var(--ui-border-soft)] bg-[var(--ui-surface-elevated)] text-text-muted shadow-sm transition-colors hover:border-red-500/35 hover:text-red-400"
                onClick={(event) => {
                  event.stopPropagation();
                  deleteEdge(id);
                }}
                aria-label={t('canvas.disconnectEdge')}
              >
                <UiIcon icon={CancelCircleIcon} className="h-4 w-4" />
              </button>
            </UiTooltip>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});
