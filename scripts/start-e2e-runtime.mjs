#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { startProductionLuminaRuntime } from '../runtime/productionRuntime.mjs';
import { createFileProjectLibrary } from '../runtime/fileProjectLibrary.mjs';
import { createTestManagedLibraryRoot } from '../runtime/fileProjectLibrary/managedRoot.mjs';
import { startRuntimeProjectService } from '../runtime/runtimeProjectService.mjs';

const port = Number(process.env.LUMINA_E2E_PORT ?? 48100);
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-e2e-runtime-'));
let runtime;
let closing = false;

try {
  runtime = await startProductionLuminaRuntime({
    metadataDirectory: path.join(fixture, 'metadata'),
    startProjectService: () => startRuntimeProjectService({
      library: createFileProjectLibrary({
        testManagedRoot: createTestManagedLibraryRoot(path.join(fixture, 'library')),
      }),
    }),
    portCandidates: [port],
    runtimeVersion: '0.2.32',
  });
  if (runtime.status !== 'started') {
    throw new Error(`Production Runtime did not start: ${runtime.status}.`);
  }

  const close = async () => {
    if (closing) return;
    closing = true;
    await runtime?.runtime?.close();
    await fs.rm(fixture, { recursive: true, force: true });
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  process.once('exit', () => {
    void fs.rm(fixture, { recursive: true, force: true });
  });
  await new Promise(() => {});
} catch (error) {
  await runtime?.runtime?.close();
  await fs.rm(fixture, { recursive: true, force: true });
  throw error;
}
