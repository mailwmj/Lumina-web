import { describe, expect, it } from 'vitest';

import {
  CUSTOM_IMAGE_PROTOCOLS,
  getCustomImageProtocolDefinition,
  migrateCustomImageBaseUrlForProtocolChange,
  normalizeCustomImageRemoteModelId,
  normalizeCustomImageProtocol,
} from './imageProviderProtocols';

describe('custom image provider protocols', () => {
  it('switches a versioned OpenAI-compatible base URL to Gemini Native', () => {
    expect(migrateCustomImageBaseUrlForProtocolChange(
      'https://api.ai-media.vip/v1',
      'openai-images',
      'gemini-native'
    )).toBe('https://api.ai-media.vip/v1beta');
  });

  it('switches a versioned Gemini Native base URL to OpenAI-compatible', () => {
    expect(migrateCustomImageBaseUrlForProtocolChange(
      'https://gateway.example/v1beta/',
      'gemini-native',
      'openai-images'
    )).toBe('https://gateway.example/v1');
  });

  it('preserves an endpoint whose path is not a protocol version', () => {
    expect(migrateCustomImageBaseUrlForProtocolChange(
      'https://gateway.example/api/gemini',
      'openai-images',
      'gemini-native'
    )).toBe('https://gateway.example/api/gemini');
  });

  it('uses the FHL default endpoint when switching an empty configuration to FHL', () => {
    expect(migrateCustomImageBaseUrlForProtocolChange(
      '',
      'openai-images',
      'fhl-images'
    )).toBe('https://www.fhl.mom');
  });

  it('exposes FHL as a dedicated custom-provider backend protocol', () => {
    expect(CUSTOM_IMAGE_PROTOCOLS).toContain('fhl-images');
    expect(getCustomImageProtocolDefinition('fhl-images').backendProviderId).toBe('fhl');
    expect(normalizeCustomImageProtocol('fhl')).toBe('fhl-images');
    expect(normalizeCustomImageRemoteModelId('fhl-images', 'fhl/gpt-image-2')).toBe('gpt-image-2');
  });

  it('keeps every custom protocol on its existing backend capability boundary', () => {
    expect(getCustomImageProtocolDefinition('openai-images').backendProviderId).toBe('openai');
    expect(getCustomImageProtocolDefinition('fhl-images').backendProviderId).toBe('fhl');
    expect(getCustomImageProtocolDefinition('gemini-native').backendProviderId).toBe('gemini');
  });
});
