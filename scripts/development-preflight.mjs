#!/usr/bin/env node
/* global AbortSignal, fetch */
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  defaultMetadataDirectory,
  readInstallationMetadata,
} from '../runtime/installationMetadata.mjs';

export const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export const MINIMUM_DEVELOPMENT_NODE_MAJOR = 20;

const ROOT_DEPENDENCIES = Object.freeze([
  ['TypeScript', 'node_modules/typescript/bin/tsc'],
  ['Vite', 'node_modules/vite/bin/vite.js'],
]);
const CANVAS_AGENT_DEPENDENCIES = Object.freeze([
  ['canvas-agent TypeScript', 'canvas-agent/node_modules/typescript/bin/tsc'],
]);
const REQUIRED_ARTIFACTS = Object.freeze([
  'dist/index.html',
  'canvas-agent/web-dist/index.html',
  'canvas-agent/dist/index.js',
  'canvas-agent/dist/web/http.js',
  'canvas-agent/dist/web/protocol.js',
]);
const WEB_SOURCE_PATHS = Object.freeze([
  'src', 'public', 'index.html', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts',
]);
const CANVAS_AGENT_SOURCE_PATHS = Object.freeze([
  'canvas-agent/src', 'canvas-agent/package.json', 'canvas-agent/package-lock.json', 'canvas-agent/tsconfig.json',
]);

export async function inspectDevelopmentEnvironment(options = {}) {
  const root = path.resolve(options.repositoryRoot ?? repositoryRoot);
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const nodeMajor = Number.parseInt(nodeVersion.split('.', 1)[0], 10);
  const rootDependencies = await inspectDependencies(root, ROOT_DEPENDENCIES);
  const canvasAgentDependencies = await inspectDependencies(root, CANVAS_AGENT_DEPENDENCIES);
  const artifacts = await inspectRuntimeArtifacts(root);
  const runtime = await inspectRegisteredRuntime(options.runtimeInspection);
  return {
    node: {
      actual: nodeVersion,
      minimumMajor: MINIMUM_DEVELOPMENT_NODE_MAJOR,
      ready: Number.isInteger(nodeMajor) && nodeMajor >= MINIMUM_DEVELOPMENT_NODE_MAJOR,
    },
    rootDependencies,
    canvasAgentDependencies,
    artifacts,
    runtime,
  };
}

export function assertDevelopmentReady(report, {
  requireArtifacts = false,
  requireCanvasAgent = true,
} = {}) {
  const messages = [];
  if (!report.node.ready) {
    messages.push(`Node.js >=${report.node.minimumMajor} is required; found ${report.node.actual}.`);
  }
  if (!report.rootDependencies.ready) {
    messages.push(`Root dependencies are missing (${report.rootDependencies.missing.join(', ')}). Run: npm ci`);
  }
  if (requireCanvasAgent && !report.canvasAgentDependencies.ready) {
    messages.push(`canvas-agent dependencies are missing (${report.canvasAgentDependencies.missing.join(', ')}). Run: npm ci --prefix canvas-agent`);
  }
  if (requireArtifacts && report.artifacts.status !== 'ready') {
    messages.push(`Runtime build artifacts are ${report.artifacts.status}. Run: npm run canvas:runtime:build`);
  }
  if (messages.length > 0) throw new Error(messages.join('\n'));
}

export function formatDevelopmentPreflight(report, { mode = 'runtime' } = {}) {
  const dependencyStatus = (result) => result.ready ? 'ready' : `missing: ${result.missing.join(', ')}`;
  const runtimeDetail = report.runtime.origin ? `${report.runtime.status} (${report.runtime.origin})` : report.runtime.status;
  const lines = [
    `Lumina ${mode === 'ui-only' ? 'UI-only' : 'Runtime'} development preflight`,
    `- Node.js: ${report.node.ready ? 'ready' : 'unsupported'} (${report.node.actual}; requires >=${report.node.minimumMajor})`,
    `- Root dependencies: ${dependencyStatus(report.rootDependencies)}`,
    `- canvas-agent dependencies: ${dependencyStatus(report.canvasAgentDependencies)}`,
    `- Runtime artifacts: ${report.artifacts.status}`,
    `- Registered Runtime: ${runtimeDetail}`,
  ];
  if (mode === 'ui-only') {
    lines.push('- Project API: unavailable in this UI-only Vite session; use npm run canvas:runtime for the complete product.');
  }
  return lines.join('\n');
}

export async function inspectRuntimeArtifacts(root = repositoryRoot) {
  const missing = [];
  for (const relativePath of REQUIRED_ARTIFACTS) {
    try {
      const stat = await fs.stat(path.join(root, relativePath));
      if (!stat.isFile() || stat.size === 0) missing.push(relativePath);
    } catch {
      missing.push(relativePath);
    }
  }
  if (missing.length > 0) return { status: 'missing', missing };

  if (!await directoriesMatch(
    path.join(root, 'dist'),
    path.join(root, 'canvas-agent', 'web-dist'),
  )) {
    return { status: 'invalid', missing: [] };
  }

  const webStale = await newestMtime(root, WEB_SOURCE_PATHS)
    > (await fs.stat(path.join(root, 'dist', 'index.html'))).mtimeMs;
  const agentStale = await newestMtime(root, CANVAS_AGENT_SOURCE_PATHS)
    > (await fs.stat(path.join(root, 'canvas-agent', 'dist', 'index.js'))).mtimeMs;
  return { status: webStale || agentStale ? 'stale' : 'ready', missing: [] };
}

async function inspectDependencies(root, dependencies) {
  const missing = [];
  for (const [label, relativePath] of dependencies) {
    try {
      await fs.access(path.join(root, relativePath));
    } catch {
      missing.push(label);
    }
  }
  return { ready: missing.length === 0, missing };
}

async function inspectRegisteredRuntime(overrides = {}) {
  const metadataDirectory = overrides.metadataDirectory ?? defaultMetadataDirectory();
  const readMetadata = overrides.readMetadata ?? readInstallationMetadata;
  const fetchHealth = overrides.fetchHealth ?? fetch;
  let metadata;
  try {
    metadata = await readMetadata(metadataDirectory);
  } catch {
    return { status: 'metadata-invalid' };
  }
  if (!metadata) return { status: 'not-registered' };
  try {
    const response = await fetchHealth(`${metadata.origin}/health`, {
      signal: AbortSignal.timeout(500),
    });
    const health = response.ok ? await response.json() : null;
    return {
      status: health?.status === 'healthy' && health?.installationId === metadata.installationId
        ? 'healthy'
        : 'unavailable',
      origin: metadata.origin,
    };
  } catch {
    return { status: 'unavailable', origin: metadata.origin };
  }
}

async function directoriesMatch(left, right) {
  const leftFiles = await listFiles(left);
  const rightFiles = await listFiles(right);
  if (leftFiles.length !== rightFiles.length) return false;
  for (let index = 0; index < leftFiles.length; index += 1) {
    const leftRelative = path.relative(left, leftFiles[index]);
    const rightRelative = path.relative(right, rightFiles[index]);
    if (leftRelative !== rightRelative) return false;
    const [leftBytes, rightBytes] = await Promise.all([
      fs.readFile(leftFiles[index]),
      fs.readFile(rightFiles[index]),
    ]);
    if (!leftBytes.equals(rightBytes)) return false;
  }
  return true;
}

async function listFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(target) : [target];
  }));
  return files.flat().sort();
}

async function newestMtime(root, relativePaths) {
  let newest = 0;
  for (const relativePath of relativePaths) {
    newest = Math.max(newest, await newestPathMtime(path.join(root, relativePath)));
  }
  return newest;
}

async function newestPathMtime(target) {
  const stat = await fs.stat(target);
  if (!stat.isDirectory()) return stat.mtimeMs;
  const entries = await fs.readdir(target, { withFileTypes: true });
  const mtimes = await Promise.all(entries.map((entry) => newestPathMtime(path.join(target, entry.name))));
  return Math.max(stat.mtimeMs, ...mtimes);
}

async function runCli() {
  const args = new Set(process.argv.slice(2));
  const mode = args.has('--ui-only') ? 'ui-only' : 'runtime';
  const requireArtifacts = args.has('--require-artifacts');
  const report = await inspectDevelopmentEnvironment();
  process.stdout.write(`${formatDevelopmentPreflight(report, { mode })}\n`);
  assertDevelopmentReady(report, {
    requireArtifacts,
    requireCanvasAgent: mode !== 'ui-only',
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await runCli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Lumina development preflight failed.'}\n`);
    process.exitCode = 1;
  }
}
