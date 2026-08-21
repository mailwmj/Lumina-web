// @vitest-environment happy-dom

import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stubs = vi.hoisted(() => ({
  importAudio: vi.fn(),
  importVideo: vi.fn(),
  setSelectedNode: vi.fn(),
  updateNodeData: vi.fn(),
}));

vi.mock('@xyflow/react', () => ({
  Handle: () => <div />,
  Position: { Right: 'right' },
  useUpdateNodeInternals: () => vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/features/assets/ui/useMediaDisplayUrl', () => ({
  useMediaDisplayUrl: () => null,
}));

vi.mock('@/features/canvas/ui/NodeResizeHandle', () => ({
  NodeResizeHandle: () => <div />,
}));

vi.mock('@/features/canvas/application/canvasServices', () => ({
  canvasMediaProcessor: {
    importAudio: stubs.importAudio,
    importVideo: stubs.importVideo,
  },
}));

vi.mock('@/stores/canvasStore', () => ({
  useCanvasStore: () => stubs.updateNodeData,
}));

vi.mock('@/stores/projectStore', () => ({
  useProjectStore: () => () => ({ id: 'project-1' }),
}));

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: () => true,
}));

import { AudioUploadNode } from './SD2AudioUploadNode';
import { VideoUploadNode } from './SD2VideoUploadNode';

async function selectFile(input: HTMLInputElement, file: File): Promise<void> {
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('media upload node retries', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('keeps an audio node empty after a failed import and accepts a retry', async () => {
    stubs.importAudio
      .mockRejectedValueOnce(new Error('Gateway transcoding is temporarily unavailable.'))
      .mockResolvedValueOnce({
        assetId: 'asset-audio-1', mediaUrl: null, sourceFileName: 'voice.wav',
        sourceMimeType: 'audio/wav', mimeType: 'audio/wav', durationMs: 1_000, width: null, height: null,
      });

    await act(async () => {
      root.render(<AudioUploadNode {...{
        id: 'audio-1', type: 'audioUploadRef', data: { assetId: null, audioUrl: null },
      } as unknown as ComponentProps<typeof AudioUploadNode>} />);
    });

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['audio'], 'voice.wav', { type: 'audio/wav' });
    await selectFile(input, file);

    expect(stubs.updateNodeData).not.toHaveBeenCalled();
    expect(container.textContent).toContain('node.audioUploadRef.importFailed');

    await selectFile(input, file);

    expect(stubs.updateNodeData).toHaveBeenCalledWith('audio-1', expect.objectContaining({
      assetId: 'asset-audio-1', audioUrl: null,
    }));
    expect(container.textContent).not.toContain('node.audioUploadRef.importFailed');
  });

  it('keeps a video node empty after a failed import and accepts a retry', async () => {
    stubs.importVideo
      .mockRejectedValueOnce(new Error('Gateway transcoding is temporarily unavailable.'))
      .mockResolvedValueOnce({
        assetId: 'asset-video-1', mediaUrl: null, sourceFileName: 'clip.mp4',
        sourceMimeType: 'video/mp4', mimeType: 'video/mp4', durationMs: 2_000, width: 1_280, height: 720,
      });

    await act(async () => {
      root.render(<VideoUploadNode {...{
        id: 'video-1', type: 'videoUploadRef', data: { assetId: null, videoUrl: null },
      } as unknown as ComponentProps<typeof VideoUploadNode>} />);
    });

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['video'], 'clip.mp4', { type: 'video/mp4' });
    await selectFile(input, file);

    expect(stubs.updateNodeData).not.toHaveBeenCalled();
    expect(container.textContent).toContain('node.videoUploadRef.importFailed');

    await selectFile(input, file);

    expect(stubs.updateNodeData).toHaveBeenCalledWith('video-1', expect.objectContaining({
      assetId: 'asset-video-1', videoUrl: null,
    }));
    expect(container.textContent).not.toContain('node.videoUploadRef.importFailed');
  });
});
