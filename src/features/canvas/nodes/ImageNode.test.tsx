// @vitest-environment happy-dom

import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CANVAS_NODE_TYPES, type ExportImageNodeData } from '@/features/canvas/domain/canvasNodes';

vi.mock('@xyflow/react', () => ({
  Handle: () => <div />,
  Position: { Left: 'left', Right: 'right' },
  useUpdateNodeInternals: () => vi.fn(),
}));

vi.mock('@/features/canvas/hooks/useCanvasNodeImageSource', () => ({
  useCanvasNodeImageSource: () => null,
}));

vi.mock('@/features/assets/ui/useMediaDisplayUrl', () => ({
  useMediaDisplayUrl: () => null,
}));

vi.mock('@/features/canvas/ui/NodeResizeHandle', () => ({
  NodeResizeHandle: () => <div />,
}));

import { ImageNode } from './ImageNode';

function imageNodeProps(data: ExportImageNodeData): ComponentProps<typeof ImageNode> {
  return {
    id: 'result-1',
    type: CANVAS_NODE_TYPES.exportImage,
    data,
  } as ComponentProps<typeof ImageNode>;
}

describe('ImageNode generation recovery display', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('renders persisted sanitized failure details after rehydration', async () => {
    const data: ExportImageNodeData = {
      resultKind: 'generic',
      imageUrl: null,
      aspectRatio: '1:1',
      isGenerating: false,
      generationError: 'Rejected Bearer [REDACTED]',
      generationErrorDetails: 'Provider request failed with HTTP 429.',
      generationProviderRequestId: 'req-provider-2',
    };

    await act(async () => {
      root.render(<ImageNode {...imageNodeProps(data)} />);
    });

    expect(container.textContent).toContain('Rejected Bearer [REDACTED]');
    expect(container.textContent).toContain('req-provider-2');
  });

  it('renders persisted recovery details with the manual original-task requery action', async () => {
    const data: ExportImageNodeData = {
      resultKind: 'generic',
      imageUrl: null,
      aspectRatio: '1:1',
      isGenerating: true,
      generationRecoveryState: 'attention_required',
      generationRetryError: 'Network authorization=[REDACTED] timed out.',
    };

    await act(async () => {
      root.render(<ImageNode {...imageNodeProps(data)} />);
    });

    expect(container.textContent).toContain('Network authorization=[REDACTED] timed out.');
    expect(container.querySelector('button')).not.toBeNull();
  });
});
