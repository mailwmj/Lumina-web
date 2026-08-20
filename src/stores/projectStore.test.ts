import { describe, expect, it } from 'vitest';

import { canvasNodeFactory } from '@/features/canvas/application/canvasServices';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import { sanitizeProjectNodesForPersistence } from './projectStore';

describe('text generation project persistence', () => {
  it('keeps durable text data and removes runtime run state', () => {
    const node = canvasNodeFactory.createNode(CANVAS_NODE_TYPES.textGeneration, { x: 0, y: 0 }, {
      inputText: 'input',
      generatedText: 'result',
      textApiId: 'provider-a',
      textModelId: 'model-a',
      isGenerating: true,
      generationError: 'temporary error',
      generationErrorDetails: 'temporary details',
    });

    const [sanitized] = sanitizeProjectNodesForPersistence([node]);

    expect(sanitized.data).toMatchObject({
      inputText: 'input',
      generatedText: 'result',
      textApiId: 'provider-a',
      textModelId: 'model-a',
    });
    expect(sanitized.data).not.toHaveProperty('isGenerating');
    expect(sanitized.data).not.toHaveProperty('generationError');
    expect(sanitized.data).not.toHaveProperty('generationErrorDetails');
  });
});
