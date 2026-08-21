import type {
  GenerationJobSubmissionReceipt,
  GenerationJobSubmissionListener,
  GenerationJobSubmissionResult,
} from './ports';
import { logger } from '@/lib/logger';

interface SubmitGenerationJobBatchInput {
  outputCount: number;
  submit: (outputIndex: number) => Promise<GenerationJobSubmissionReceipt>;
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
      const receipt = await submit(outputIndex);
      result = { status: 'fulfilled', ...receipt };
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
