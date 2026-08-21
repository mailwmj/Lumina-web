import { describe, expect, it } from 'vitest';

import { canApplyImageGenerationPollResult } from './generationJobLifecycle';

describe('image generation poll lifecycle', () => {
  const activeNode = {
    id: 'result-1',
    data: {
      isGenerating: true,
      generationJobId: 'job-1',
    },
  };

  it('rejects late results after stop, project switch, or a stale task replacement', () => {
    expect(canApplyImageGenerationPollResult({
      expectedProjectId: 'project-1',
      currentProjectId: 'project-1',
      nodeId: 'result-1',
      jobId: 'job-1',
      currentNode: activeNode,
    })).toBe(true);

    expect(canApplyImageGenerationPollResult({
      expectedProjectId: 'project-1',
      currentProjectId: 'project-1',
      nodeId: 'result-1',
      jobId: 'job-1',
      currentNode: { ...activeNode, data: { ...activeNode.data, isGenerating: false } },
    })).toBe(false);
    expect(canApplyImageGenerationPollResult({
      expectedProjectId: 'project-1',
      currentProjectId: 'project-2',
      nodeId: 'result-1',
      jobId: 'job-1',
      currentNode: activeNode,
    })).toBe(false);
    expect(canApplyImageGenerationPollResult({
      expectedProjectId: 'project-1',
      currentProjectId: 'project-1',
      nodeId: 'result-1',
      jobId: 'job-1',
      currentNode: { ...activeNode, data: { ...activeNode.data, generationJobId: 'job-2' } },
    })).toBe(false);
  });
});
