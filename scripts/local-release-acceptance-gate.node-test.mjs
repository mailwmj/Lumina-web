import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { URL } from 'node:url';

import {
  evaluateLocalReleaseEvidence,
  readLocalReleaseContract,
  readLocalReleaseEvidence,
  validateLocalReleaseContract,
} from './local-release-acceptance.mjs';

test('the local release contract fixes every Issue 39 acceptance path and automated check', () => {
  const contract = readLocalReleaseContract();

  assert.deepEqual(contract.automatedChecks.map((check) => check.id), [
    'typecheck',
    'build',
    'local-runtime',
    'installer',
    'gateway',
    'canvas-agent',
    'plugin',
    'production-runtime-chromium',
  ]);
  assert.deepEqual(contract.scenarios.map((scenario) => scenario.id), [
    'windows-installer-lifecycle',
    'macos-installer-lifecycle',
    'dual-entry-browser-library',
    'explicit-authorization',
    'fail-closed-recovery',
    'remote-provider-without-local-weights',
    'repair-diagnostics',
  ]);
  assert.deepEqual(
    contract.requiredManualEvidence.find((entry) => entry.id === 'windows-chrome-codex-dual-entry-x64').requiredObservations,
    [
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
  );
  assert.equal(
    contract.requiredManualEvidence.find((entry) => entry.id === 'macos-signed-clean-install-arm64').requiresNotarization,
    true,
  );
  assert.deepEqual(
    contract.requiredManualEvidence
      .filter((entry) => entry.platform !== 'cross-platform')
      .map((entry) => `${entry.platform}:${entry.architecture}`),
    [
      'windows:x64', 'windows:arm64', 'windows:x64', 'windows:arm64', 'macos:x64', 'macos:arm64',
      'macos:x64', 'macos:arm64', 'windows:x64', 'windows:arm64', 'macos:x64', 'macos:arm64',
    ],
  );

  const altered = JSON.parse(JSON.stringify(contract));
  altered.scenarios.pop();
  assert.throws(
    () => validateLocalReleaseContract(altered),
    /frozen Issue 39 acceptance contract/i,
  );
});

test('a pending platform matrix keeps the local release gate at beta and blocks complete admission', () => {
  const contract = readLocalReleaseContract();
  const evidence = readLocalReleaseEvidence({ contract });
  const evaluation = evaluateLocalReleaseEvidence(evidence, {
    channel: 'complete',
    verifiedCheckIds: contract.automatedChecks.map((check) => check.id),
    contract,
  });

  assert.equal(evaluation.releaseTier, 'beta');
  assert.match(evaluation.blockers.join('\n'), /windows-signed-clean-install/i);

  const result = spawnSync(process.execPath, [
    'scripts/local-release-acceptance-gate.mjs',
    '--channel',
    'complete',
    '--json',
  ], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /"releaseTier":"beta"/);
});

test('verified manual evidence must name an existing signed release artifact and capture', () => {
  const contract = readLocalReleaseContract();
  const evidence = readLocalReleaseEvidence({ contract });
  const entry = evidence.manualEvidence.find((candidate) => candidate.id === 'windows-signed-clean-install-x64');
  entry.status = 'verified';
  entry.evidence = { record: 'docs/deployment/evidence/missing-windows-record.json' };
  delete entry.reason;

  assert.throws(
    () => evaluateLocalReleaseEvidence(evidence, { channel: 'beta', contract }),
    /missing-windows-record\.json/i,
  );
});

test('verified platform evidence cannot substitute a different supported architecture', () => {
  const contract = readLocalReleaseContract();
  const evidence = readLocalReleaseEvidence({ contract });
  const entry = evidence.manualEvidence.find((candidate) => candidate.id === 'windows-signed-clean-install-x64');
  const required = contract.requiredManualEvidence.find((candidate) => candidate.id === entry.id);
  const root = fs.mkdtempSync(path.join(process.cwd(), '.local-release-evidence-'));
  const relativeRoot = path.relative(process.cwd(), root).replaceAll('\\', '/');
  try {
    fs.writeFileSync(path.join(root, 'record.json'), JSON.stringify({
      schemaVersion: 1,
      kind: 'local-release-manual',
      id: entry.id,
      platform: 'windows',
      releaseVersion: '0.2.32',
      osVersion: 'test',
      architecture: 'arm64',
      observedAt: new Date().toISOString(),
      coverage: required.coverage,
    }));
    entry.status = 'verified';
    entry.evidence = { record: `${relativeRoot}/record.json` };
    delete entry.reason;

    assert.throws(
      () => evaluateLocalReleaseEvidence(evidence, { channel: 'beta', contract }),
      /architecture must be x64/i,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('verified manual evidence rejects a directory disguised as a capture artifact', () => {
  const contract = readLocalReleaseContract();
  const evidence = readLocalReleaseEvidence({ contract });
  const entry = evidence.manualEvidence.find((candidate) => candidate.id === 'remote-provider-without-local-weights');
  const root = fs.mkdtempSync(path.join(process.cwd(), '.local-release-evidence-'));
  const relativeRoot = path.relative(process.cwd(), root).replaceAll('\\', '/');
  const capturePath = path.join(root, 'capture');
  try {
    fs.mkdirSync(capturePath);
    fs.writeFileSync(path.join(root, 'record.json'), JSON.stringify({
      schemaVersion: 1,
      kind: 'local-release-manual',
      id: entry.id,
      platform: 'cross-platform',
      releaseVersion: '0.2.32',
      osVersion: 'test',
      architecture: 'x64',
      observedAt: new Date().toISOString(),
      coverage: ['remote-provider-without-local-weights'],
      observations: [
        {
          id: 'remote-provider-request-completed',
          outcome: 'passed',
          detail: 'Remote provider completed the approved request.',
          artifacts: [`${relativeRoot}/capture`],
        },
        {
          id: 'no-local-model-weights',
          outcome: 'passed',
          detail: 'The runtime did not load local model weights.',
          artifacts: [`${relativeRoot}/capture`],
        },
      ],
      provider: 'test-provider',
      model: 'test-model',
      usedLocalWeights: false,
    }));
    entry.status = 'verified';
    entry.evidence = { record: `${relativeRoot}/record.json` };
    delete entry.reason;

    const statSync = fs.statSync;
    fs.statSync = (target, ...args) => path.resolve(target) === capturePath
      ? { isFile: () => false, size: 1 }
      : statSync(target, ...args);
    try {
      assert.throws(
        () => evaluateLocalReleaseEvidence(evidence, { channel: 'beta', contract }),
        /non-empty repository artifact/i,
      );
    } finally {
      fs.statSync = statSync;
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('verified platform evidence recalculates the referenced installer SHA-256', () => {
  const contract = readLocalReleaseContract();
  const evidence = readLocalReleaseEvidence({ contract });
  const entry = evidence.manualEvidence.find((candidate) => candidate.id === 'windows-signed-clean-install-x64');
  const required = contract.requiredManualEvidence.find((candidate) => candidate.id === entry.id);
  const root = fs.mkdtempSync(path.join(process.cwd(), '.local-release-evidence-'));
  const relativeRoot = path.relative(process.cwd(), root).replaceAll('\\', '/');
  try {
    fs.writeFileSync(path.join(root, 'LuminaSetup.exe'), 'installer fixture');
    fs.writeFileSync(path.join(root, 'capture.txt'), 'capture fixture');
    fs.writeFileSync(path.join(root, 'signature.txt'), 'signature fixture');
    fs.writeFileSync(path.join(root, 'record.json'), JSON.stringify({
      schemaVersion: 1,
      kind: 'local-release-manual',
      id: entry.id,
      platform: 'windows',
      releaseVersion: '0.2.32',
      osVersion: 'test',
      architecture: 'x64',
      observedAt: new Date().toISOString(),
      coverage: required.coverage,
      observations: required.requiredObservations.map((id) => ({
        id,
        outcome: 'passed',
        detail: `${id} completed.`,
        artifacts: [`${relativeRoot}/capture.txt`],
      })),
      installerArtifact: `${relativeRoot}/LuminaSetup.exe`,
      installerSha256: '0'.repeat(64),
      signatureVerification: {
        status: 'verified',
        tool: 'signtool',
        command: 'signtool verify /pa LuminaSetup.exe',
        signer: 'Lumina test signer',
        artifacts: [`${relativeRoot}/signature.txt`],
      },
    }));
    entry.status = 'verified';
    entry.evidence = { record: `${relativeRoot}/record.json` };
    delete entry.reason;

    assert.throws(
      () => evaluateLocalReleaseEvidence(evidence, { channel: 'beta', contract }),
      /must match the referenced installer SHA-256/i,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('verified macOS package evidence requires a notarization verification artifact', () => {
  const contract = readLocalReleaseContract();
  const evidence = readLocalReleaseEvidence({ contract });
  const entry = evidence.manualEvidence.find((candidate) => candidate.id === 'macos-signed-clean-install-arm64');
  const required = contract.requiredManualEvidence.find((candidate) => candidate.id === entry.id);
  const root = fs.mkdtempSync(path.join(process.cwd(), '.local-release-evidence-'));
  const relativeRoot = path.relative(process.cwd(), root).replaceAll('\\', '/');
  const installer = 'installer fixture';
  try {
    fs.writeFileSync(path.join(root, 'Lumina.pkg'), installer);
    fs.writeFileSync(path.join(root, 'capture.txt'), 'capture fixture');
    fs.writeFileSync(path.join(root, 'signature.txt'), 'signature fixture');
    fs.writeFileSync(path.join(root, 'record.json'), JSON.stringify({
      schemaVersion: 1,
      kind: 'local-release-manual',
      id: entry.id,
      platform: 'macos',
      releaseVersion: '0.2.32',
      osVersion: 'test',
      architecture: 'arm64',
      observedAt: new Date().toISOString(),
      coverage: required.coverage,
      observations: required.requiredObservations.map((id) => ({
        id,
        outcome: 'passed',
        detail: `${id} completed.`,
        artifacts: [`${relativeRoot}/capture.txt`],
      })),
      installerArtifact: `${relativeRoot}/Lumina.pkg`,
      installerSha256: createHash('sha256').update(installer).digest('hex'),
      signatureVerification: {
        status: 'verified',
        tool: 'codesign',
        command: 'codesign --verify --deep --strict Lumina.pkg',
        signer: 'Lumina test signer',
        artifacts: [`${relativeRoot}/signature.txt`],
      },
    }));
    entry.status = 'verified';
    entry.evidence = { record: `${relativeRoot}/record.json` };
    delete entry.reason;

    assert.throws(
      () => evaluateLocalReleaseEvidence(evidence, { channel: 'beta', contract }),
      /notarizationVerification/i,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
