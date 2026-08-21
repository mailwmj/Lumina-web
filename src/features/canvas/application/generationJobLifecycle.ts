interface GenerationPollNode {
  id: string;
  data: unknown;
}

interface CanApplyImageGenerationPollResultInput {
  expectedProjectId: string | null;
  currentProjectId: string | null;
  nodeId: string;
  jobId: string;
  currentNode: GenerationPollNode | undefined;
}

export function canApplyImageGenerationPollResult({
  expectedProjectId,
  currentProjectId,
  nodeId,
  jobId,
  currentNode,
}: CanApplyImageGenerationPollResultInput): boolean {
  const data = currentNode?.data as Record<string, unknown> | undefined;
  return currentProjectId === expectedProjectId
    && currentNode?.id === nodeId
    && data?.isGenerating === true
    && data.generationJobId === jobId;
}
