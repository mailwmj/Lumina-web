import type {
  GenerationJobSubmissionListener,
  GenerationJobSubmissionResult,
} from './ports';
import { logger } from '@/lib/logger';

interface SubmitGenerationJobBatchInput {
  outputCount: number;
  submit: (outputIndex: number) => Promise<string>;
  onSettled: GenerationJobSubmissionListener;
}

export async function submitGenerationJobBatch({
  outputCount,
  submit,
  onSettled,
}: SubmitGenerationJobBatchInput): Promise<GenerationJobSubmissionResult[]> {
  const submissions = Array.from({ length: outputCount }, async (_, outputIndex) => {
    let result: GenerationJobSubmissionResult;
    try {
      const jobId = await submit(outputIndex);
      result = { status: 'fulfilled', jobId };
    } catch (error) {
      result = { status: 'rejected', error };
    }
    try {
      onSettled(result, outputIndex);
    } catch (error) {
      logger.error('[GenerationJobBatch] submission listener failed', {
        outputIndex,
        error,
      });
    }
    return result;
  });

  return Promise.all(submissions);
}
