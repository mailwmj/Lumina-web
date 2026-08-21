import { startLocalCanvasHost } from './localCanvasHost.js';
import { startReadonlyCanvasCompanion, type ReadonlyCanvasCompanion } from './http.js';

export interface ReadonlyCanvasRuntime extends ReadonlyCanvasCompanion {
  close(): Promise<void>;
}

export async function startReadonlyCanvasRuntime(webRoot: string): Promise<ReadonlyCanvasRuntime> {
  const host = await startLocalCanvasHost(webRoot);
  try {
    const companion = await startReadonlyCanvasCompanion({ canonicalOrigin: host.origin });
    return {
      ...companion,
      close: async () => {
        try {
          await companion.close();
        } finally {
          await host.close();
        }
      },
    };
  } catch (error) {
    await host.close();
    throw error;
  }
}
