import { beforeEach, describe, expect, it, vi } from 'vitest';

import { tauriAiGateway } from './tauriAiGateway';

const commands = vi.hoisted(() => ({
  generateImage: vi.fn(),
  getGenerateImageJob: vi.fn(),
  retryGenerateImageJob: vi.fn(),
  setApiKey: vi.fn(),
  submitGenerateImageJob: vi.fn(),
}));

const imageData = vi.hoisted(() => ({
  persistImageLocally: vi.fn(),
}));

const media = vi.hoisted(() => ({
  uploadMediaToTos: vi.fn(),
}));

vi.mock('@/commands/ai', () => commands);
vi.mock('@/commands/image', () => ({ uploadImageToVolcVod: vi.fn() }));
vi.mock('@/features/canvas/application/imageData', () => ({
  isLikelyLocalImagePath: () => true,
  persistImageLocally: imageData.persistImageLocally,
}));
vi.mock('@/commands/media', () => media);

describe('tauriAiGateway batch submission boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('revalidates only after asynchronous reference normalization and before submit', async () => {
    let finishNormalization: ((path: string) => void) | undefined;
    imageData.persistImageLocally.mockReturnValue(new Promise<string>((resolve) => {
      finishNormalization = resolve;
    }));
    const order: string[] = [];
    commands.submitGenerateImageJob.mockImplementation(async () => {
      order.push('submit');
      return 'job-1';
    });

    const submission = tauriAiGateway.submitGenerateImageJobs({
      prompt: 'Generate one image',
      model: 'provider/edit-model',
      size: '1K',
      aspectRatio: '1:1',
      referenceImages: ['/local/reference.png'],
      projectId: 'project-1',
    }, 1, vi.fn(), () => {
      order.push('guard');
    });

    await Promise.resolve();
    expect(order).toEqual([]);
    finishNormalization?.('/project/reference.png');
    await submission;

    expect(order).toEqual(['guard', 'submit']);
  });

  it('forwards a selected Volcengine-compatible video configuration at submission time', async () => {
    commands.submitGenerateImageJob.mockResolvedValue('video-job-1');
    const providerConfig = {
      api_key: 'yunxin-key',
      base_url: 'https://ai.yunxinapi.com/hub/volcengine',
      config_id: 'yunxin-seedance',
      protocol: 'volcengine-seedance',
    };

    await tauriAiGateway.submitGenerateImageJob({
      prompt: 'A rainy city at night',
      model: 'custom-seedance-model',
      providerId: 'volcvideo',
      size: '720p',
      aspectRatio: '16:9',
      providerConfig,
    });

    expect(commands.submitGenerateImageJob).toHaveBeenCalledWith({
      prompt: 'A rainy city at night',
      model: 'custom-seedance-model',
      provider_id: 'volcvideo',
      size: '720p',
      aspect_ratio: '16:9',
      reference_images: undefined,
      extra_params: undefined,
      provider_config: providerConfig,
      draftTaskId: undefined,
      project_id: undefined,
    });
  });

  it('forwards ordered typed Seedance content without encoding roles into the prompt', async () => {
    commands.submitGenerateImageJob.mockResolvedValue('video-job-2');
    media.uploadMediaToTos
      .mockResolvedValueOnce({ key: 'ref', url: 'https://tos.example/ref.png', expiresAt: 1, contentType: 'image/png', sizeBytes: 1 })
      .mockResolvedValueOnce({ key: 'video', url: 'https://tos.example/source.mp4', expiresAt: 1, contentType: 'video/mp4', sizeBytes: 1 })
      .mockResolvedValueOnce({ key: 'audio', url: 'https://tos.example/music.mp3', expiresAt: 1, contentType: 'audio/mpeg', sizeBytes: 1 });
    const providerConfig = {
      api_key: 'seedance-key',
      base_url: 'https://ark.example/api/v3',
      config_id: 'seedance-2',
      protocol: 'volcengine-seedance',
    };

    await tauriAiGateway.submitGenerateImageJob({
      prompt: 'The provider receives its typed content separately',
      model: 'doubao-seedance-2-0-260128',
      providerId: 'volcvideo',
      size: '720p',
      aspectRatio: '16:9',
      videoContent: [
        { type: 'image_url', role: 'reference_image', url: 'https://media.example/ref.png' },
        { type: 'video_url', role: 'reference_video', url: 'https://media.example/source.mp4' },
        { type: 'audio_url', role: 'reference_audio', url: 'https://media.example/music.mp3' },
        { type: 'text', text: 'The provider receives its typed content separately' },
      ],
      providerConfig,
    });

    expect(commands.submitGenerateImageJob).toHaveBeenCalledWith({
      prompt: 'The provider receives its typed content separately',
      model: 'doubao-seedance-2-0-260128',
      provider_id: 'volcvideo',
      size: '720p',
      aspect_ratio: '16:9',
      reference_images: undefined,
      video_content: [
        { type: 'image_url', role: 'reference_image', url: 'https://tos.example/ref.png' },
        { type: 'video_url', role: 'reference_video', url: 'https://tos.example/source.mp4' },
        { type: 'audio_url', role: 'reference_audio', url: 'https://tos.example/music.mp3' },
        { type: 'text', text: 'The provider receives its typed content separately' },
      ],
      extra_params: undefined,
      provider_config: providerConfig,
      draftTaskId: undefined,
      project_id: undefined,
    });
  });

  it('normalizes local typed image, video, and audio media without changing public URLs or content order', async () => {
    commands.submitGenerateImageJob.mockResolvedValue('video-job-3');
    media.uploadMediaToTos
      .mockResolvedValueOnce({ key: 'reference', url: 'https://public.example/reference.png', expiresAt: 1, contentType: 'image/png', sizeBytes: 1 })
      .mockResolvedValueOnce({ key: 'source', url: 'https://public.example/source.mp4', expiresAt: 1, contentType: 'video/mp4', sizeBytes: 1 })
      .mockResolvedValueOnce({ key: 'music', url: 'https://public.example/music.mp3', expiresAt: 1, contentType: 'audio/mpeg', sizeBytes: 1 })
      .mockResolvedValueOnce({ key: 'remote', url: 'https://public.example/remote.png', expiresAt: 1, contentType: 'image/png', sizeBytes: 1 });

    await tauriAiGateway.submitGenerateImageJob({
      prompt: 'Typed content remains ordered after upload',
      model: 'doubao-seedance-2-0-260128',
      providerId: 'volcvideo',
      size: '720p',
      aspectRatio: '16:9',
      videoContent: [
        { type: 'image_url', role: 'reference_image', url: '/project/reference.png' },
        { type: 'video_url', role: 'reference_video', url: 'file:///project/source.mp4' },
        { type: 'audio_url', role: 'reference_audio', url: 'data:audio/mpeg;base64,AAAA' },
        { type: 'image_url', role: 'reference_image', url: 'https://media.example/remote.png' },
        { type: 'text', text: 'Typed content remains ordered after upload' },
      ],
    });

    expect(media.uploadMediaToTos).toHaveBeenCalledTimes(4);
    expect(commands.submitGenerateImageJob).toHaveBeenCalledWith(expect.objectContaining({
      video_content: [
        { type: 'image_url', role: 'reference_image', url: 'https://public.example/reference.png' },
        { type: 'video_url', role: 'reference_video', url: 'https://public.example/source.mp4' },
        { type: 'audio_url', role: 'reference_audio', url: 'https://public.example/music.mp3' },
        { type: 'image_url', role: 'reference_image', url: 'https://public.example/remote.png' },
        { type: 'text', text: 'Typed content remains ordered after upload' },
      ],
    }));
  });
});
