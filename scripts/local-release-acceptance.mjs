import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

import {
  isRecord,
  requireArray,
  requireString,
  sameJson,
  validateManualEvidenceRecord,
} from './local-release-evidence-records.mjs';

export const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export const defaultLocalReleaseContractPath = path.join(
  repositoryRoot,
  'docs',
  'deployment',
  'local-release-acceptance-contract.json',
);
export const defaultLocalReleaseEvidencePath = path.join(
  repositoryRoot,
  'docs',
  'deployment',
  'local-release-acceptance-evidence.json',
);

const PLATFORM_RELEASE_OBSERVATIONS = Object.freeze([
  'clean-install',
  'runtime-health',
  'protocol-open',
  'project-create',
  'runtime-restart-project-restored',
  'upgrade',
  'repair',
  'reinstall',
  'managed-library-root-selected',
  'managed-library-preserved',
  'plugin-import',
  'mcp-start',
  'node-version-incompatible',
  'runtime-missing',
  'runtime-version-incompatible',
  'connected-chrome-open-focus',
  'chrome-disconnected',
  'chrome-reconnected',
  'project-revision-matches',
  'no-visible-canvas-window',
]);

const frozenContract = {
  schemaVersion: 2,
  issue: 39,
  baseline: '00ec88c1cc000b4b84899fa6a74b1590b26fdb0a',
  evidenceMaxAgeDays: 35,
  automatedChecks: [
    { id: 'typecheck', command: ['npx', 'tsc', '--noEmit'] },
    { id: 'build', command: ['npm', 'run', 'build'] },
    { id: 'local-runtime', command: ['npm', 'run', 'test:local-runtime'] },
    { id: 'installer', command: ['npm', 'run', 'test:installer'] },
    { id: 'gateway', command: ['npx', 'vitest', 'run', 'gateway'] },
    { id: 'canvas-agent', command: ['npm', 'run', 'canvas-agent:test'] },
    { id: 'plugin', command: ['node', '--test', 'plugins/lumina-canvas/plugin.node-test.mjs'] },
    { id: 'production-runtime-chromium', command: ['npm', 'run', 'test:production-runtime'] },
    { id: 'github-installers', command: ['npm', 'run', 'test:github-installers'] },
  ],
  scenarios: [
    {
      id: 'windows-x64-runtime-installation',
      automatedChecks: ['installer', 'local-runtime', 'github-installers'],
    },
    {
      id: 'macos-arm64-runtime-installation',
      automatedChecks: ['installer', 'local-runtime', 'github-installers'],
    },
    {
      id: 'codex-plugin-diagnostics',
      automatedChecks: ['installer', 'local-runtime', 'plugin'],
    },
    {
      id: 'connected-chrome-runtime-library',
      automatedChecks: ['canvas-agent', 'plugin', 'production-runtime-chromium'],
    },
    {
      id: 'fail-closed-recovery',
      automatedChecks: ['local-runtime', 'canvas-agent', 'plugin'],
    },
    {
      id: 'remote-provider-without-local-weights',
      automatedChecks: ['gateway', 'build'],
    },
  ],
  requiredManualEvidence: [
    {
      id: 'windows-x64-release-candidate',
      platform: 'windows',
      architecture: 'x64',
      coverage: [
        'windows-x64-runtime-installation',
        'codex-plugin-diagnostics',
        'connected-chrome-runtime-library',
        'fail-closed-recovery',
      ],
      requiresSignedArtifact: true,
      installerExtension: '.exe',
      requiredObservations: PLATFORM_RELEASE_OBSERVATIONS,
    },
    {
      id: 'macos-arm64-release-candidate',
      platform: 'macos',
      architecture: 'arm64',
      coverage: [
        'macos-arm64-runtime-installation',
        'codex-plugin-diagnostics',
        'connected-chrome-runtime-library',
        'fail-closed-recovery',
      ],
      requiresSignedArtifact: true,
      requiresNotarization: true,
      installerExtension: '.pkg',
      requiredObservations: PLATFORM_RELEASE_OBSERVATIONS,
    },
    {
      id: 'remote-provider-without-local-weights',
      platform: 'cross-platform',
      coverage: ['remote-provider-without-local-weights'],
      requiresSignedArtifact: false,
      requiredObservations: ['remote-provider-request-completed', 'no-local-model-weights'],
    },
  ],
};

function fail(message) {
  throw new Error(message);
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    fail(`Unable to read ${label} ${filePath}: ${error.message}`);
  }
}

export function validateLocalReleaseContract(contract) {
  if (!isRecord(contract) || !sameJson(contract, frozenContract)) {
    fail('Local release contract differs from the frozen Runtime-first acceptance contract.');
  }
  return contract;
}

export function readLocalReleaseContract(contractPath = defaultLocalReleaseContractPath) {
  return validateLocalReleaseContract(readJson(contractPath, 'local release contract'));
}

export function validateLocalReleaseEvidence(evidence, { contract, root = repositoryRoot } = {}) {
  if (!contract) fail('A validated local release contract is required.');
  if (!isRecord(evidence) || evidence.schemaVersion !== 2 || evidence.issue !== contract.issue) {
    fail('Local release evidence must identify the Runtime-first contract with schemaVersion 2.');
  }
  if (evidence.baseline !== contract.baseline) {
    fail('Local release evidence must use the frozen Runtime-first baseline.');
  }
  requireArray(evidence.manualEvidence, 'manualEvidence');
  if (!sameJson(
    evidence.manualEvidence.map((entry) => entry.id),
    contract.requiredManualEvidence.map((entry) => entry.id),
  )) {
    fail('Local release evidence must include every frozen manual evidence record in order.');
  }
  for (const [index, entry] of evidence.manualEvidence.entries()) {
    const required = contract.requiredManualEvidence[index];
    if (!isRecord(entry) || (entry.status !== 'pending' && entry.status !== 'verified')) {
      fail(`manualEvidence.${required.id} must be pending or verified.`);
    }
    if (entry.status === 'pending') {
      requireString(entry.reason, `manualEvidence.${required.id}.reason`);
    } else {
      validateManualEvidenceRecord({ entry, required, maxAgeDays: contract.evidenceMaxAgeDays, root });
    }
  }
  return evidence;
}

export function readLocalReleaseEvidence({
  evidencePath = defaultLocalReleaseEvidencePath,
  contract = readLocalReleaseContract(),
  root = repositoryRoot,
} = {}) {
  return validateLocalReleaseEvidence(readJson(evidencePath, 'local release evidence'), { contract, root });
}

export function evaluateLocalReleaseEvidence(evidence, {
  channel = 'beta',
  verifiedCheckIds = [],
  contract,
} = {}) {
  if (channel !== 'beta' && channel !== 'complete') {
    fail(`Unknown local release channel ${channel}.`);
  }
  validateLocalReleaseEvidence(evidence, { contract });
  const blockers = [];
  const verified = new Set(verifiedCheckIds);
  for (const check of contract.automatedChecks) {
    if (!verified.has(check.id)) blockers.push(`Automated check not verified: ${check.id}.`);
  }
  for (const entry of evidence.manualEvidence) {
    if (entry.status !== 'verified') blockers.push(`Manual evidence pending: ${entry.id}.`);
  }
  return {
    issue: contract.issue,
    requestedChannel: channel,
    releaseTier: blockers.length === 0 ? 'complete' : 'beta',
    blockers,
  };
}
