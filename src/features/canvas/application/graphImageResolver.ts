import {
  CANVAS_NODE_TYPES,
  isExportImageNode,
  isImageEditNode,
  isUploadNode,
  type CanvasEdge,
  type CanvasWorkflowNode,
} from '../domain/canvasNodes';
import type { GraphImageResolver } from './ports';
import type { MediaReference } from '@/features/assets/application/mediaDisplayResolver';
import { logger } from '@/lib/logger';

export class DefaultGraphImageResolver implements GraphImageResolver {
  collectInputImages(
    nodeId: string,
    nodes: readonly CanvasWorkflowNode[],
    edges: readonly CanvasEdge[]
  ): MediaReference[] {
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const targetNode = nodes.find((n) => n.id === nodeId);
    const isVideoFrame = targetNode?.type === CANVAS_NODE_TYPES.videoFrame;

    // Debug logging - use setTimeout to avoid blocking
    setTimeout(() => {
      logger.debug(
        `collectInputImages: nodeId=${nodeId}, isVideoFrame=${isVideoFrame}, total edges=${edges.length}`,
        { context: 'graphImageResolver.collectInputImages' }
      );
    }, 0);

    // Collect edges targeting this node with their handle IDs
    const targetEdges = edges.filter((edge) => edge.target === nodeId);

    logger.info('[GraphImageResolver] nodeId:', nodeId, 'isVideoFrame:', isVideoFrame, 'total edges to this node:', targetEdges.length);
    targetEdges.forEach((edge, idx) => {
      logger.info('[GraphImageResolver] edge[' + idx + ']: source=' + edge.source + ', targetHandle=' + edge.targetHandle);
    });

    // 添加详细日志
    logger.info('[GraphImageResolver] === DETAILED EDGE ANALYSIS ===');
    logger.info('[GraphImageResolver] Looking for target-first edge...');
    const firstFrameEdge = targetEdges.find((e) => e.targetHandle === 'target-first');
    logger.info('[GraphImageResolver] target-first edge:', firstFrameEdge ? JSON.stringify({source: firstFrameEdge.source, target: firstFrameEdge.target, targetHandle: firstFrameEdge.targetHandle}) : 'NOT FOUND');
    logger.info('[GraphImageResolver] Looking for target-last edge...');
    const lastFrameEdge = targetEdges.find((e) => e.targetHandle === 'target-last');
    logger.info('[GraphImageResolver] target-last edge:', lastFrameEdge ? JSON.stringify({source: lastFrameEdge.source, target: lastFrameEdge.target, targetHandle: lastFrameEdge.targetHandle}) : 'NOT FOUND');

    if (isVideoFrame) {
      // 对于首尾帧节点，按 handle 分开收集图片
      // target-first 对应首帧，target-last 对应尾帧
      const firstFrameEdge = targetEdges.find((e) => e.targetHandle === 'target-first');
      const lastFrameEdge = targetEdges.find((e) => e.targetHandle === 'target-last');

      logger.info('[GraphImageResolver] firstFrameEdge:', firstFrameEdge ? 'found (source=' + firstFrameEdge.source + ')' : 'not found');
      logger.info('[GraphImageResolver] lastFrameEdge:', lastFrameEdge ? 'found (source=' + lastFrameEdge.source + ')' : 'not found');

      const firstImage = firstFrameEdge
        ? this.extractFirstImage(nodeById.get(firstFrameEdge.source))
        : null;
      const lastImage = lastFrameEdge
        ? this.extractFirstImage(nodeById.get(lastFrameEdge.source))
        : null;

      logger.info('[GraphImageResolver] firstImage:', firstImage ? 'available' : 'null');
      logger.info('[GraphImageResolver] lastImage:', lastImage ? 'available' : 'null');

      // 返回 [首帧, 尾帧] 的顺序
      const result = [firstImage, lastImage].filter((img): img is MediaReference => img !== null);
      logger.info('[GraphImageResolver] returning', result.length, 'images for videoFrame');
      return result;
    } else {
      // 普通节点：收集所有输入图片
      const images: MediaReference[] = [];
      for (const edge of targetEdges) {
        const sourceNode = nodeById.get(edge.source);
        if (sourceNode) {
          const nodeImages = this.extractImages(sourceNode);
          images.push(...nodeImages);
        }
      }
      return [...new Set(images)];
    }
  }

  /**
   * 只提取第一张图片（用于视频节点每个 handle 只取一张图）
   */
  private extractFirstImage(node: CanvasWorkflowNode | undefined): MediaReference | null {
    if (!node) {
      return null;
    }

    if (isUploadNode(node) || isImageEditNode(node) || isExportImageNode(node)) {
      const reference = this.createImageReference(node.data.assetId, node.data.imageUrl);
      logger.info('[GraphImageResolver] extractFirstImage from', node.type, ':', reference ? 'available' : 'null');
      return reference;
    }

    return null;
  }

  private extractImages(node: CanvasWorkflowNode | undefined): MediaReference[] {
    if (!node) {
      return [];
    }

    if (isUploadNode(node) || isImageEditNode(node) || isExportImageNode(node)) {
      const reference = this.createImageReference(node.data.assetId, node.data.imageUrl);
      return reference ? [reference] : [];
    }

    return [];
  }

  private createImageReference(
    assetId: string | null | undefined,
    legacyUrl: string | null | undefined,
  ): MediaReference | null {
    const normalizedAssetId = assetId?.trim() || null;
    const normalizedLegacyUrl = legacyUrl?.trim() || null;
    if (!normalizedAssetId && !normalizedLegacyUrl) {
      return null;
    }
    return {
      kind: 'image',
      assetId: normalizedAssetId,
      legacyUrl: normalizedLegacyUrl,
    };
  }
}
