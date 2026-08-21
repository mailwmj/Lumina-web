#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  defaultManifestPath,
  evaluateReleaseEvidence,
  isReleaseChannel,
  readReleaseEvidence,
} from './web-release-evidence.mjs';
import { readReleaseContract, repositoryRoot } from './web-release-contract.mjs';

function fail(message) {
  throw new Error(message);
}

function resolveCommand(command, args) {
  if (command === 'node') {
    return { command: process.execPath, args, shell: false };
  }
  if (process.platform === 'win32' && (command === 'npm' || command === 'npx')) {
    const npmCli = path.join(
      path.dirname(process.execPath),
      'node_modules',
      'npm',
      'bin',
      `${command}-cli.js`,
    );
    if (fs.existsSync(npmCli)) {
      return { command: process.execPath, args: [npmCli, ...args], shell: false };
    }
    return { command: `${command}.cmd`, args, shell: true };
  }
  return { command, args, shell: false };
}

function runAutomatedChecks(checks) {
  const verifiedCheckIds = [];
  for (const check of checks) {
    const [command, ...args] = check.command;
    const resolved = resolveCommand(command, args);
    process.stderr.write(`\n==> ${check.id}\n`);
    const result = spawnSync(resolved.command, resolved.args, {
      cwd: repositoryRoot,
      env: { ...process.env, ...check.environment },
      shell: resolved.shell,
      stdio: 'inherit',
    });
    if (result.error) {
      fail(`${check.id} could not start: ${result.error.message}`);
    }
    if (result.status !== 0) {
      fail(`${check.id} failed with exit code ${result.status ?? 'unknown'}.`);
    }
    verifiedCheckIds.push(check.id);
  }
  return verifiedCheckIds;
}

function parseCliArgs(args) {
  const options = {
    channel: 'beta',
    json: false,
    manifestPath: defaultManifestPath,
    verify: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--channel') {
      const value = args[index + 1];
      if (!value) {
        fail('Missing release channel after --channel.');
      }
      options.channel = value;
      index += 1;
      continue;
    }
    if (arg === '--manifest') {
      const value = args[index + 1];
      if (!value) {
        fail('Missing evidence path after --manifest.');
      }
      options.manifestPath = path.resolve(repositoryRoot, value);
      index += 1;
      continue;
    }
    if (arg === '--verify') {
      options.verify = true;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    fail(`Unknown option ${arg}.`);
  }

  if (!isReleaseChannel(options.channel)) {
    fail(`Unknown release channel ${options.channel}.`);
  }
  return options;
}

function formatEvaluation(evaluation) {
  const lines = [
    `v0.2.37 Web release gate: ${evaluation.releaseTier.toUpperCase()}`,
    `Requested channel: ${evaluation.requestedChannel}`,
  ];
  if (evaluation.blockers.length === 0) {
    lines.push('All required evidence and product confirmation are recorded.');
  } else {
    lines.push('Unresolved evidence:');
    for (const blocker of evaluation.blockers) {
      lines.push(`- ${blocker}`);
    }
  }
  return lines.join('\n');
}

function runCli() {
  try {
    const options = parseCliArgs(process.argv.slice(2));
    const contract = readReleaseContract();
    const manifest = readReleaseEvidence(options.manifestPath, { contract });
    const verifiedCheckIds = options.verify ? runAutomatedChecks(contract.automatedChecks) : [];
    const evaluation = evaluateReleaseEvidence(manifest, {
      channel: options.channel,
      verifiedCheckIds,
      contract,
    });

    if (options.json) {
      process.stdout.write(`${JSON.stringify(evaluation)}\n`);
    } else {
      process.stdout.write(`${formatEvaluation(evaluation)}\n`);
    }
    if (options.channel === 'complete' && evaluation.releaseTier !== 'complete') {
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli();
}
