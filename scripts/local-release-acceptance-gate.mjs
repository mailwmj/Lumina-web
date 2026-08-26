#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

import {
  defaultLocalReleaseEvidencePath,
  evaluateLocalReleaseEvidence,
  readLocalReleaseContract,
  readLocalReleaseEvidence,
  repositoryRoot,
} from './local-release-acceptance.mjs';

function fail(message) {
  throw new Error(message);
}

function parseOptions(args) {
  const options = { channel: 'beta', evidencePath: defaultLocalReleaseEvidencePath, json: false, verify: false };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--channel') {
      options.channel = args[index + 1];
      index += 1;
    } else if (value === '--evidence') {
      options.evidencePath = path.resolve(repositoryRoot, args[index + 1]);
      index += 1;
    } else if (value === '--json') {
      options.json = true;
    } else if (value === '--verify') {
      options.verify = true;
    } else {
      fail(`Unknown option ${value}.`);
    }
  }
  if (options.channel !== 'beta' && options.channel !== 'complete') {
    fail(`Unknown local release channel ${options.channel}.`);
  }
  return options;
}

function resolveCommand(command, args) {
  if (command === 'node') return { command: process.execPath, args, shell: false };
  if (process.platform === 'win32' && (command === 'npm' || command === 'npx')) {
    const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', `${command}-cli.js`);
    if (fs.existsSync(npmCli)) return { command: process.execPath, args: [npmCli, ...args], shell: false };
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
      shell: resolved.shell,
      stdio: 'inherit',
    });
    if (result.error) fail(`${check.id} could not start: ${result.error.message}`);
    if (result.status !== 0) fail(`${check.id} failed with exit code ${result.status ?? 'unknown'}.`);
    verifiedCheckIds.push(check.id);
  }
  return verifiedCheckIds;
}

function runCli() {
  try {
    const options = parseOptions(process.argv.slice(2));
    const contract = readLocalReleaseContract();
    const evidence = readLocalReleaseEvidence({ evidencePath: options.evidencePath, contract });
    const verifiedCheckIds = options.verify ? runAutomatedChecks(contract.automatedChecks) : [];
    const evaluation = evaluateLocalReleaseEvidence(evidence, {
      channel: options.channel,
      verifiedCheckIds,
      contract,
    });
    if (options.json) {
      process.stdout.write(`${JSON.stringify(evaluation)}\n`);
    } else {
      process.stdout.write(`Runtime-first local release gate: ${evaluation.releaseTier.toUpperCase()}\n`);
      for (const blocker of evaluation.blockers) process.stdout.write(`- ${blocker}\n`);
    }
    if (options.channel === 'complete' && evaluation.releaseTier !== 'complete') process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

runCli();
