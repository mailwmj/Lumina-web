import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';

import {
  evaluateReleaseEvidence,
  readReleaseEvidence,
  validateReleaseEvidence,
} from './web-release-evidence.mjs';
import { readReleaseContract, validateReleaseContract } from './web-release-contract.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const manifestPath = path.join(repositoryRoot, 'docs', 'migration', 'v0.2.37-release-evidence.json');

function readManifest() {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

function runGate(channel) {
  return spawnSync(process.execPath, [
    'scripts/web-release-gate.mjs',
    '--channel',
    channel,
    '--json',
  ], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
}

function writeFixtureFile(root, relativePath, contents = 'fixture') {
  const destination = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, contents);
}

function writeReleaseEvidenceFixture(root, manifest, contract, browserVersions = {}) {
  writeFixtureFile(root, manifest.baseline.matrix);
  for (const row of manifest.rows) {
    for (const implementation of row.implementation) {
      const destination = path.join(root, implementation);
      if (implementation.endsWith('/')) {
        fs.mkdirSync(destination, { recursive: true });
      } else {
        writeFixtureFile(root, implementation);
      }
    }
    row.manualEvidence = row.manualEvidence.map((entry) => ({
      id: entry.id,
      status: 'pending',
      reason: 'Fixture does not claim row-level browser evidence.',
    }));
    row.exceptionEvidence = row.exceptionEvidence.map((entry) => ({
      id: entry.id,
      status: 'pending',
      reason: 'Fixture does not claim exception evidence.',
    }));
  }

  for (const expected of contract.requiredBrowserEvidence) {
    const entry = manifest.browserEvidence.find((candidate) => candidate.id === expected.id);
    entry.status = 'verified';
    entry.evidence = { record: `records/${expected.id}.json` };
    delete entry.reason;
    writeFixtureFile(root, `artifacts/${expected.id}.png`);
    writeFixtureFile(root, `records/${expected.id}.json`, JSON.stringify({
      schemaVersion: 1,
      kind: 'manual',
      id: expected.id,
      browser: expected.browser,
      browserVersion: browserVersions[expected.id] ?? (
        expected.browserVersionRole === 'previous' ? '139.0.0.0' : '140.0.0.0'
      ),
      browserChannel: expected.browserChannel,
      browserVersionRole: expected.browserVersionRole,
      supportScope: expected.supportScope,
      observedAt: new Date().toISOString(),
      viewport: '1440x900',
      locale: 'en-US',
      theme: 'light',
      scenario: 'Representative Web release acceptance path.',
      coverage: ['project', 'assets', 'generation', 'import-export', 'offline'],
      artifacts: [`artifacts/${expected.id}.png`],
    }));
  }

  const evidencePath = path.join(root, 'release-evidence.json');
  fs.writeFileSync(evidencePath, JSON.stringify(manifest));
  return evidencePath;
}

test('the frozen contract fixes all required matrix rows and release checks', () => {
  const contract = readReleaseContract();

  assert.deepEqual(
    contract.requiredRows.map((row) => row.id),
    ['project', 'canvas', 'image', 'storyboard', 'text', 'video', 'batch-crop', 'settings', 'codex'],
  );
  assert.deepEqual(
    contract.requiredBrowserEvidence.map((entry) => entry.id),
    ['chrome-latest', 'chrome-previous', 'edge-latest', 'edge-previous', 'connected-chrome-codex-entry'],
  );
  assert.deepEqual(contract.requiredBrowserEvidence[4], {
    id: 'connected-chrome-codex-entry',
    browser: 'Connected Chrome',
    browserChannel: 'connected-chrome',
    browserVersionRole: 'representative',
    supportScope: 'pre-cutover-connected-chrome-shared-library-codex',
  });
  assert.deepEqual(
    contract.requiredBrowserEvidence.map((entry) => entry.browserVersionRole),
    ['latest', 'previous', 'latest', 'previous', 'representative'],
  );
  assert.deepEqual(
    contract.requiredBrowserEvidence.map((entry) => entry.supportScope),
    [
      'web-renderer-compatibility',
      'web-renderer-compatibility',
      'web-renderer-compatibility',
      'web-renderer-compatibility',
      'pre-cutover-connected-chrome-shared-library-codex',
    ],
  );
  assert.equal(contract.browserEvidencePolicy.maxEvidenceAgeDays, 35);
  assert.equal(contract.automatedChecks.length, 12);

  const altered = JSON.parse(JSON.stringify(contract));
  altered.automatedChecks[0].command = ['node', '--version'];
  assert.throws(() => validateReleaseContract(altered), /frozen v0\.2\.37 required matrix and test plan/i);
});

test('a complete replacement cannot omit a frozen matrix row', () => {
  const contract = readReleaseContract();
  const manifest = readManifest();
  manifest.rows.pop();

  assert.throws(
    () => validateReleaseEvidence(manifest, contract),
    /every frozen required matrix row/i,
  );
});

test('verified manual and exception evidence require structured records', () => {
  const contract = readReleaseContract();
  const manifest = readManifest();
  manifest.rows[0].manualEvidence[0] = {
    id: 'supported-browser',
    status: 'verified',
    evidence: 'evidence/project-supported-browser.md',
  };

  assert.throws(
    () => validateReleaseEvidence(manifest, contract),
    /evidence must be an object/i,
  );

  manifest.rows[0].manualEvidence[0] = {
    id: 'supported-browser',
    status: 'verified',
    evidence: { record: 'docs/migration/evidence/missing-manual-record.json' },
  };
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-release-gate-'));
  const temporaryManifest = path.join(temporaryDirectory, 'release-evidence.json');
  fs.writeFileSync(temporaryManifest, JSON.stringify(manifest));
  try {
    assert.throws(
      () => readReleaseEvidence(temporaryManifest, { contract }),
      /missing-manual-record\.json/i,
    );
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('supported-browser evidence rejects duplicate latest and previous majors', () => {
  const contract = readReleaseContract();
  const manifest = readManifest();
  const temporaryDirectory = fs.mkdtempSync(path.join(repositoryRoot, '.release-gate-fixture-'));
  try {
    const evidencePath = writeReleaseEvidenceFixture(temporaryDirectory, manifest, contract, {
      'chrome-previous': '140.0.0.0',
    });

    assert.throws(
      () => readReleaseEvidence(evidencePath, { contract, root: temporaryDirectory }),
      /latest and previous .* different adjacent browser majors/i,
    );
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('supported-browser evidence rejects stale version captures', () => {
  const contract = readReleaseContract();
  const manifest = readManifest();
  const temporaryDirectory = fs.mkdtempSync(path.join(repositoryRoot, '.release-gate-fixture-'));
  try {
    const evidencePath = writeReleaseEvidenceFixture(temporaryDirectory, manifest, contract);
    const recordPath = path.join(temporaryDirectory, 'records', 'chrome-latest.json');
    const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    record.observedAt = '2020-01-01T00:00:00.000Z';
    fs.writeFileSync(recordPath, JSON.stringify(record));

    assert.throws(
      () => readReleaseEvidence(evidencePath, { contract, root: temporaryDirectory }),
      /must be no more than 35 days old/i,
    );
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('renderer evidence cannot be relabeled as connected-Chrome shared-library coverage', () => {
  const contract = readReleaseContract();
  const manifest = readManifest();
  const temporaryDirectory = fs.mkdtempSync(path.join(repositoryRoot, '.release-gate-fixture-'));
  try {
    const evidencePath = writeReleaseEvidenceFixture(temporaryDirectory, manifest, contract);
    const recordPath = path.join(temporaryDirectory, 'records', 'edge-latest.json');
    const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    record.supportScope = 'pre-cutover-connected-chrome-shared-library-codex';
    fs.writeFileSync(recordPath, JSON.stringify(record));

    assert.throws(
      () => readReleaseEvidence(evidencePath, { contract, root: temporaryDirectory }),
      /supportScope must be web-renderer-compatibility/i,
    );
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('verified row manual evidence must match a supported-browser record', () => {
  const contract = readReleaseContract();
  const manifest = readManifest();
  const temporaryDirectory = fs.mkdtempSync(path.join(repositoryRoot, '.release-gate-fixture-'));
  try {
    const evidencePath = writeReleaseEvidenceFixture(temporaryDirectory, manifest, contract);
    const entry = manifest.rows[0].manualEvidence[0];
    entry.status = 'verified';
    entry.evidence = { record: 'records/project-manual.json' };
    delete entry.reason;
    writeFixtureFile(temporaryDirectory, 'artifacts/project-manual.png');
    writeFixtureFile(temporaryDirectory, 'records/project-manual.json', JSON.stringify({
      schemaVersion: 1,
      kind: 'manual',
      id: entry.id,
      browser: 'Firefox',
      browserVersion: '140.0.0.0',
      browserEvidenceId: 'chrome-latest',
      supportScope: 'web-renderer-compatibility',
      viewport: '1440x900',
      locale: 'en-US',
      theme: 'light',
      scenario: 'Project walkthrough.',
      artifacts: ['artifacts/project-manual.png'],
    }));
    fs.writeFileSync(evidencePath, JSON.stringify(manifest));

    assert.throws(
      () => readReleaseEvidence(evidencePath, { contract, root: temporaryDirectory }),
      /must match browser evidence chrome-latest/i,
    );
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('row manual evidence cannot claim a scope broader than its browser record', () => {
  const contract = readReleaseContract();
  const manifest = readManifest();
  const temporaryDirectory = fs.mkdtempSync(path.join(repositoryRoot, '.release-gate-fixture-'));
  try {
    const evidencePath = writeReleaseEvidenceFixture(temporaryDirectory, manifest, contract);
    const entry = manifest.rows[0].manualEvidence[0];
    entry.status = 'verified';
    entry.evidence = { record: 'records/project-manual.json' };
    delete entry.reason;
    writeFixtureFile(temporaryDirectory, 'artifacts/project-manual.png');
    writeFixtureFile(temporaryDirectory, 'records/project-manual.json', JSON.stringify({
      schemaVersion: 1,
      kind: 'manual',
      id: entry.id,
      browser: 'Edge',
      browserVersion: '140.0.0.0',
      browserEvidenceId: 'edge-latest',
      supportScope: 'pre-cutover-connected-chrome-shared-library-codex',
      viewport: '1440x900',
      locale: 'en-US',
      theme: 'light',
      scenario: 'Project walkthrough.',
      artifacts: ['artifacts/project-manual.png'],
    }));
    fs.writeFileSync(evidencePath, JSON.stringify(manifest));

    assert.throws(
      () => readReleaseEvidence(evidencePath, { contract, root: temporaryDirectory }),
      /supportScope must match browser evidence edge-latest/i,
    );
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('the checked-in v0.2.37 evidence report is explicitly Beta and complete promotion is rejected', () => {
  const autoResult = runGate('auto');
  assert.equal(autoResult.status, 0, autoResult.stderr);
  const autoEvaluation = JSON.parse(autoResult.stdout);
  assert.equal(autoEvaluation.releaseTier, 'beta');
  assert.equal(autoEvaluation.declaredStatus, 'beta');
  assert.ok(autoEvaluation.blockers.includes('product-confirmation'));
  assert.equal(autoEvaluation.rows.length, 9);

  const completeResult = runGate('complete');
  assert.equal(completeResult.status, 1);
  const completeEvaluation = JSON.parse(completeResult.stdout);
  assert.equal(completeEvaluation.releaseTier, 'beta');
  assert.ok(completeEvaluation.blockers.includes('product-confirmation'));
});

test('an auto evaluation cannot promote a declared Beta manifest', () => {
  const contract = readReleaseContract();
  const manifest = readReleaseEvidence(manifestPath, { contract });
  const evaluation = evaluateReleaseEvidence(manifest, {
    channel: 'auto',
    verifiedCheckIds: contract.automatedChecks.map((check) => check.id),
    contract,
  });

  assert.equal(evaluation.releaseTier, 'beta');
  assert.equal(evaluation.declaredStatus, 'beta');
});
