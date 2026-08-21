import { startLocalCanvasHost } from '../readonly/localCanvasHost.js';
import { startWebCanvasCompanion, type WebCanvasCompanion } from './http.js';

export interface WebCanvasRuntime extends WebCanvasCompanion {
  close(): Promise<void>;
}

export async function startWebCanvasRuntime(webRoot: string): Promise<WebCanvasRuntime> {
  const host = await startLocalCanvasHost(webRoot);
  try {
    const companion = await startWebCanvasCompanion({ canonicalOrigin: host.origin });
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
