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

const supportedArchitectures = ['x64', 'arm64'];

function platformEvidence({ id, platform, coverage, installerExtension, requiredObservations, requiresNotarization = false }) {
  return supportedArchitectures.map((architecture) => ({
    id: `${id}-${architecture}`,
    platform,
    architecture,
    coverage,
    requiresSignedArtifact: true,
    ...(requiresNotarization ? { requiresNotarization: true } : {}),
    installerExtension,
    requiredObservations,
  }));
}

const frozenContract = {
  schemaVersion: 1,
  issue: 39,
  baseline: '1dc2b23e15bed47d5d35b700ecd09d209e2b6a88',
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
  ],
  scenarios: [
    {
      id: 'windows-installer-lifecycle',
      automatedChecks: ['installer', 'local-runtime'],
    },
    {
      id: 'macos-installer-lifecycle',
      automatedChecks: ['installer', 'local-runtime'],
    },
    {
      id: 'dual-entry-browser-library',
      automatedChecks: ['local-runtime', 'canvas-agent', 'plugin', 'production-runtime-chromium'],
    },
    {
      id: 'explicit-authorization',
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
    {
      id: 'repair-diagnostics',
      automatedChecks: ['installer', 'local-runtime', 'plugin'],
    },
  ],
  requiredManualEvidence: [
    ...platformEvidence({
      id: 'windows-signed-clean-install',
      platform: 'windows',
      coverage: ['windows-installer-lifecycle'],
      installerExtension: '.exe',
      requiredObservations: ['clean-install', 'first-start', 'protocol-open', 'bookmark-open', 'no-visible-canvas-window'],
    }),
    ...platformEvidence({
      id: 'windows-upgrade-repair-reinstall-uninstall',
      platform: 'windows',
      coverage: ['windows-installer-lifecycle', 'repair-diagnostics'],
      installerExtension: '.exe',
      requiredObservations: ['upgrade', 'repair', 'reinstall', 'uninstall', 'registered-origin-preserved', 'browser-library-preserved', 'data-deletion-separate'],
    }),
    ...platformEvidence({
      id: 'macos-signed-clean-install',
      platform: 'macos',
      coverage: ['macos-installer-lifecycle'],
      requiresNotarization: true,
      installerExtension: '.pkg',
      requiredObservations: ['clean-install', 'first-start', 'protocol-open', 'bookmark-open', 'no-visible-canvas-window'],
    }),
    ...platformEvidence({
      id: 'macos-upgrade-repair-reinstall-uninstall',
      platform: 'macos',
      coverage: ['macos-installer-lifecycle', 'repair-diagnostics'],
      requiresNotarization: true,
      installerExtension: '.pkg',
      requiredObservations: ['upgrade', 'repair', 'reinstall', 'uninstall', 'registered-origin-preserved', 'browser-library-preserved', 'data-deletion-separate'],
    }),
    ...platformEvidence({
      id: 'windows-chrome-codex-dual-entry',
      platform: 'windows',
      coverage: ['dual-entry-browser-library', 'explicit-authorization', 'fail-closed-recovery'],
      installerExtension: '.exe',
      requiredObservations: [
        'same-chrome-profile',
        'same-registered-origin',
        'same-project-library',
        'manual-edit-visible-to-codex',
        'authorized-codex-edit-visible-to-chrome',
        'revision-matches',
        'open-read-only',
        'connect-read-only',
        'reconnect-read-only',
        'write-requires-explicit-grant',
        'import-requires-explicit-grant',
        'run-requires-explicit-grant',
        'disconnect-no-replay',
        'timeout-no-replay',
        'token-rotation-no-replay',
        'stale-revision-no-replay',
        'runtime-restart-no-replay',
        'port-occupancy-no-replay',
        'version-incompatible-repair',
        'chrome-disconnected-repair',
        'runtime-unavailable-repair',
        'protocol-entry-broken-repair',
      ],
    }),
    ...platformEvidence({
      id: 'macos-chrome-codex-dual-entry',
      platform: 'macos',
      coverage: ['dual-entry-browser-library', 'explicit-authorization', 'fail-closed-recovery'],
      requiresNotarization: true,
      installerExtension: '.pkg',
      requiredObservations: [
        'same-chrome-profile',
        'same-registered-origin',
        'same-project-library',
        'manual-edit-visible-to-codex',
        'authorized-codex-edit-visible-to-chrome',
        'revision-matches',
        'open-read-only',
        'connect-read-only',
        'reconnect-read-only',
        'write-requires-explicit-grant',
        'import-requires-explicit-grant',
        'run-requires-explicit-grant',
        'disconnect-no-replay',
        'timeout-no-replay',
        'token-rotation-no-replay',
        'stale-revision-no-replay',
        'runtime-restart-no-replay',
        'port-occupancy-no-replay',
        'version-incompatible-repair',
        'chrome-disconnected-repair',
        'runtime-unavailable-repair',
        'protocol-entry-broken-repair',
      ],
    }),
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
    fail('Local release contract differs from the frozen Issue 39 acceptance contract.');
  }
  return contract;
}

export function readLocalReleaseContract(contractPath = defaultLocalReleaseContractPath) {
  return validateLocalReleaseContract(readJson(contractPath, 'local release contract'));
}

export function validateLocalReleaseEvidence(evidence, { contract, root = repositoryRoot } = {}) {
  if (!contract) fail('A validated local release contract is required.');
  if (!isRecord(evidence) || evidence.schemaVersion !== 1 || evidence.issue !== contract.issue) {
    fail('Local release evidence must identify Issue 39 with schemaVersion 1.');
  }
  if (evidence.baseline !== contract.baseline) {
    fail('Local release evidence must use the frozen Issue 39 baseline.');
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
