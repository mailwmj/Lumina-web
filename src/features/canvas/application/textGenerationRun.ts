export type TextGenerationRunOutcome =
  | { status: 'committed'; text: string }
  | { status: 'busy' | 'stopped' | 'empty' }
  | { status: 'failed'; error: unknown };

export type TextGenerationRunner<TSnapshot> = (
  snapshot: Readonly<TSnapshot>,
  signal: AbortSignal
) => Promise<string>;

interface TextGenerationRunReadiness {
  effectivePrompt: string;
  referenceImageCount: number;
  blockingImageCount: number;
  hasResolvedModel: boolean;
}

export function canStartTextGeneration({
  effectivePrompt,
  referenceImageCount,
  blockingImageCount,
  hasResolvedModel,
}: TextGenerationRunReadiness): boolean {
  return blockingImageCount === 0
    && hasResolvedModel
    && Boolean(effectivePrompt || referenceImageCount > 0);
}

/** Owns one node's transient run. The caller commits durable canvas state. */
export class TextGenerationRunController<TSnapshot> {
  private activeRun: { id: number; abortController: AbortController } | null = null;
  private nextRunId = 1;

  isRunning(): boolean {
    return this.activeRun !== null;
  }

  stop(): boolean {
    if (!this.activeRun) {
      return false;
    }
    this.activeRun.abortController.abort();
    this.activeRun = null;
    return true;
  }

  async run(
    snapshot: Readonly<TSnapshot>,
    runner: TextGenerationRunner<TSnapshot>
  ): Promise<TextGenerationRunOutcome> {
    if (this.activeRun) {
      return { status: 'busy' };
    }

    const run = { id: this.nextRunId, abortController: new AbortController() };
    this.nextRunId += 1;
    this.activeRun = run;

    try {
      const rawText = await runner(snapshot, run.abortController.signal);
      if (this.activeRun?.id !== run.id || run.abortController.signal.aborted) {
        return { status: 'stopped' };
      }
      return rawText.trim()
        ? { status: 'committed', text: rawText }
        : { status: 'empty' };
    } catch (error) {
      if (this.activeRun?.id !== run.id || run.abortController.signal.aborted) {
        return { status: 'stopped' };
      }
      return { status: 'failed', error };
    } finally {
      if (this.activeRun?.id === run.id) {
        this.activeRun = null;
      }
    }
  }
}
