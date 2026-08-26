#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { startProductionLuminaRuntime } from '../runtime/productionRuntime.mjs';
import { createFileProjectLibrary } from '../runtime/fileProjectLibrary.mjs';
import { createTestManagedLibraryRoot } from '../runtime/fileProjectLibrary/managedRoot.mjs';
import { createSecureTemporaryDirectory } from '../runtime/fileProjectLibrary/testSupport.mjs';
import { startRuntimeProjectService } from '../runtime/runtimeProjectService.mjs';

export async function startE2eRuntime(options = {}) {
  const createTemporaryDirectory = options.createTemporaryDirectory ?? createSecureTemporaryDirectory;
  const removeDirectory = options.removeDirectory
    ?? ((directory) => fs.rm(directory, { recursive: true, force: true }));
  const startRuntime = options.startRuntime ?? startProductionLuminaRuntime;
  const startProjectService = options.startProjectService ?? startRuntimeProjectService;
  const fixture = await createTemporaryDirectory('lumina-e2e-runtime-');
  let result;
  let closePromise;

  const close = () => {
    closePromise ??= (async () => {
      try {
        await result?.runtime?.close();
      } finally {
        await removeDirectory(fixture);
      }
    })();
    return closePromise;
  };

  try {
    result = await startRuntime({
      metadataDirectory: path.join(fixture, 'metadata'),
      startProjectService: () => startProjectService({
        library: createFileProjectLibrary({
          testManagedRoot: createTestManagedLibraryRoot(path.join(fixture, 'library')),
        }),
      }),
      portCandidates: [options.port ?? Number(process.env.LUMINA_E2E_PORT ?? 48100)],
      runtimeVersion: options.runtimeVersion ?? '0.2.32',
    });
    if (result.status !== 'started') {
      throw new Error(
        `Production Runtime did not start: ${result.status}${result.reason ? ` (${result.reason})` : ''}.`,
      );
    }
    return { fixture, metadata: result.metadata, runtime: result.runtime, close };
  } catch (error) {
    await close();
    throw describeE2eStartupError(error);
  }
}

export async function runE2eRuntime(options = {}) {
  const session = await startE2eRuntime(options);
  process.stdout.write(`Lumina E2E Runtime ready at ${session.metadata.origin}\n`);
  try {
    await (options.waitForShutdown ?? waitForShutdownSignal)();
  } finally {
    await session.close();
  }
}

function waitForShutdownSignal() {
  return new Promise((resolve) => {
    const finish = () => {
      process.off('SIGINT', finish);
      process.off('SIGTERM', finish);
      resolve();
    };
    process.once('SIGINT', finish);
    process.once('SIGTERM', finish);
  });
}

function describeE2eStartupError(error) {
  if (['invalid_root', 'path_escape'].includes(error?.code)) {
    return new Error(
      `Lumina E2E Runtime temporary managed-root safety check failed (${error.code}); this is a test fixture path failure, not project data corruption.`,
      { cause: error },
    );
  }
  return error;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    await runE2eRuntime();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Lumina E2E Runtime failed.'}\n`);
    process.exitCode = 1;
  }
}
