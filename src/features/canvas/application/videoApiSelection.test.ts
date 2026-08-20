import { describe, expect, it } from 'vitest';

import type { VideoApiConfig } from '@/stores/settingsStore';

import { resolveVideoApiConfig } from './videoApiSelection';

const videoApis: VideoApiConfig[] = [
  {
    id: 'volc-origin',
    name: 'Volcengine',
    apiKey: 'origin-key',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    modelId: 'doubao-seedance-2-0-260128',
    enabled: true,
    protocol: 'volcengine-seedance',
  },
  {
    id: 'yunxin-seedance',
    name: 'NetEase Yunxin',
    apiKey: 'yunxin-key',
    baseUrl: 'https://ai.yunxinapi.com/hub/volcengine',
    modelId: 'doubao-seedance-2-0-260128',
    enabled: true,
    protocol: 'volcengine-seedance',
  },
];

describe('video API configuration selection', () => {
  it('uses the persisted configuration ID when multiple endpoints expose the same model', () => {
    expect(resolveVideoApiConfig(
      videoApis,
      'yunxin-seedance',
      'doubao-seedance-2-0-260128'
    )).toMatchObject({
      id: 'yunxin-seedance',
      apiKey: 'yunxin-key',
      baseUrl: 'https://ai.yunxinapi.com/hub/volcengine',
    });
  });

  it('maps a legacy node without configuration ID by its persisted model', () => {
    expect(resolveVideoApiConfig(
      videoApis,
      undefined,
      'doubao-seedance-2-0-260128'
    )?.id).toBe('volc-origin');
  });

  it('does not silently reroute a node whose selected configuration was removed', () => {
    expect(resolveVideoApiConfig(
      videoApis,
      'removed-config',
      'doubao-seedance-2-0-260128'
    )).toBeUndefined();
  });
});
