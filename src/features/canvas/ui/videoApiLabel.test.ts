import { describe, expect, it } from 'vitest';

import { getVideoApiControlLabel } from './videoApiLabel';

describe('getVideoApiControlLabel', () => {
  it('uses concise labels for the supported Seedance models', () => {
    expect(getVideoApiControlLabel({
      name: 'chaomo',
      modelId: 'doubao-seedance-2-0-260128',
    })).toBe('SD2.0(chaomo)');
    expect(getVideoApiControlLabel({
      name: 'volcengine',
      modelId: 'doubao-seedance-2-0-fast-260128',
    })).toBe('SD2F(volcengine)');
  });

  it('uses the model ID when a configured provider has an unknown model', () => {
    expect(getVideoApiControlLabel({
      name: 'My custom video API',
      modelId: 'vendor/video-v1',
    })).toBe('vendor/video-v1(My custom video API)');
  });

  it('omits empty provider names', () => {
    expect(getVideoApiControlLabel({
      name: ' ',
      modelId: 'doubao-seedance-2-0-260128',
    })).toBe('SD2.0');
  });
});
