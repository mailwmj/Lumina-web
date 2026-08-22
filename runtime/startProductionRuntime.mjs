import process from 'node:process';

import { startProductionLuminaRuntime } from './productionRuntime.mjs';

const result = await startProductionLuminaRuntime();
if (result.status === 'repair-required') {
  throw new Error(`Lumina local runtime requires repair: ${result.reason}.`);
}

process.stdout.write(`Lumina local runtime ready at ${result.metadata.origin}\n`);
if (result.status === 'started') {
  await new Promise((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  await result.runtime.close();
}
