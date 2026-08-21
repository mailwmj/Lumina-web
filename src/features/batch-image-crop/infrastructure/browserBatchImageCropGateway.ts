import type { BatchCropTarget, PreparedBatchCropImageData } from '../domain';
import {
  canvasBlob,
  createDefaultBrowserImageDecoder,
  prepareBrowserBatchCropImage,
  renderBrowserBatchCrop,
  type BrowserBatchCropRenderRequest,
  type BrowserImageCanvasDependencies,
  type DecodedBrowserImage,
} from './browserBatchImageCropImage';
import {
  renderBrowserFixedCanvas,
  type BrowserFixedCanvasCompositionPayload,
} from './browserBatchImageCropFixedCanvas';

export type { BrowserBatchCropRenderRequest } from './browserBatchImageCropImage';
export type { BrowserFixedCanvasCompositionPayload } from './browserBatchImageCropFixedCanvas';

export interface BrowserRenderedFixedCanvas {
  renderedPath: string;
  blankMaskPath: string;
}

export interface BrowserBatchImageCropGateway {
  prepare(
    batchId: string,
    file: File,
    rotationDegrees: number,
    target: Pick<BatchCropTarget, 'width' | 'height'>,
  ): Promise<PreparedBatchCropImageData>;
  renderCrop(request: BrowserBatchCropRenderRequest): Promise<Blob>;
  renderFixedCanvas(
    batchId: string,
    payload: BrowserFixedCanvasCompositionPayload,
  ): Promise<BrowserRenderedFixedCanvas>;
  renderFixedCanvasBlob(payload: BrowserFixedCanvasCompositionPayload): Promise<Blob>;
  cleanup(batchId: string): void;
}

export interface BrowserBatchImageCropGatewayOptions {
  createCanvas?: () => HTMLCanvasElement;
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
  decodeImage?: (file: Blob) => Promise<DecodedBrowserImage>;
  readSource?: (sourcePath: string) => Promise<Blob>;
}

async function readBrowserSource(sourcePath: string): Promise<Blob> {
  const response = await fetch(sourcePath);
  if (!response.ok) throw new Error('SOURCE_NOT_FOUND');
  return await response.blob();
}

export function createBrowserBatchImageCropGateway(
  options: BrowserBatchImageCropGatewayOptions = {},
): BrowserBatchImageCropGateway {
  const dependencies: BrowserImageCanvasDependencies = {
    createCanvas: options.createCanvas ?? (() => document.createElement('canvas')),
    decodeImage: options.decodeImage ?? createDefaultBrowserImageDecoder,
  };
  const createObjectURL = options.createObjectURL ?? ((blob: Blob) => URL.createObjectURL(blob));
  const revokeObjectURL = options.revokeObjectURL ?? ((url: string) => URL.revokeObjectURL(url));
  const readSource = options.readSource ?? readBrowserSource;
  const urlsByBatch = new Map<string, Set<string>>();
  const registerUrl = (batchId: string, blob: Blob): string => {
    const url = createObjectURL(blob);
    const urls = urlsByBatch.get(batchId) ?? new Set<string>();
    urls.add(url);
    urlsByBatch.set(batchId, urls);
    return url;
  };

  return {
    prepare: (batchId, file, rotationDegrees, target) => (
      prepareBrowserBatchCropImage(file, rotationDegrees, target, (blob) => registerUrl(batchId, blob), dependencies)
    ),
    renderCrop: (request) => renderBrowserBatchCrop(request, readSource, dependencies),
    async renderFixedCanvas(batchId, payload) {
      const { base, mask } = await renderBrowserFixedCanvas(payload, readSource, dependencies);
      const [rendered, blankMask] = await Promise.all([
        canvasBlob(base, 'image/jpeg', 1),
        canvasBlob(mask, 'image/png', 1),
      ]);
      return {
        renderedPath: registerUrl(batchId, rendered),
        blankMaskPath: registerUrl(batchId, blankMask),
      };
    },
    async renderFixedCanvasBlob(payload) {
      const { base } = await renderBrowserFixedCanvas(payload, readSource, dependencies);
      return await canvasBlob(base, 'image/jpeg', 1);
    },
    cleanup(batchId) {
      const urls = urlsByBatch.get(batchId);
      if (!urls) return;
      urls.forEach(revokeObjectURL);
      urlsByBatch.delete(batchId);
    },
  };
}

export const browserBatchImageCropGateway = createBrowserBatchImageCropGateway();
