/* global process */
import { runInstalledRuntimeCli } from './installedRuntime.mjs';

const arguments_ = process.argv.slice(2);

void main();

async function main() {
  try {
    if (arguments_[0] === '--lumina-gateway-worker') {
      await import('../gateway/server.mjs');
      return;
    }
    const result = await runInstalledRuntimeCli(arguments_);
    if (result.status === 'failed') {
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`Lumina could not start: ${error.message}\n`);
    process.exitCode = 1;
  }
}
