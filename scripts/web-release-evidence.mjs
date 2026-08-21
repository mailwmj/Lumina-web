import fs from 'node:fs';
import path from 'node:path';

import { readReleaseContract, repositoryRoot } from './web-release-contract.mjs';
import {
  fail,
  isRecord,
  requireArray,
  requireString,
  sameJson,
  validateRepositoryReferences,
} from './web-release-evidence-records.mjs';

const VALID_CHANNELS = new Set(['auto', 'beta', 'complete']);
const VALID_EVIDENCE_STATUSES = new Set(['verified', 'pending', 'unavailable']);

export const defaultManifestPath = path.join(
  repositoryRoot,
  'docs',
  'migration',
  'v0.2.37-release-evidence.json',
);

function requireEvidenceReference(value, label) {
  if (!isRecord(value)) {
    fail(`${label} must be an object.`);
  }
  requireString(value.record, `${label}.record`);
}

function validateEvidenceEntry(entry, label, { type, rowCheckIds }) {
  if (!isRecord(entry)) {
    fail(`${label} must be an object.`);
  }
  requireString(entry.id, `${label}.id`);
  if (!VALID_EVIDENCE_STATUSES.has(entry.status)) {
    fail(`${label}.status must be verified, pending, or unavailable.`);
  }
  if (entry.status !== 'verified') {
    requireString(entry.reason, `${label}.reason`);
    return;
  }

  requireEvidenceReference(entry.evidence, `${label}.evidence`);
  if (type === 'exception') {
    requireArray(entry.checks, `${label}.checks`);
    for (const checkId of entry.checks) {
      requireString(checkId, `${label}.checks entry`);
      if (!rowCheckIds.includes(checkId)) {
        fail(`${label}.checks references a check outside the row contract: ${checkId}.`);
      }
    }
  }
}

function validateEvidenceList(entries, label, options) {
  requireArray(entries, label);
  const ids = new Set();
  for (const [index, entry] of entries.entries()) {
    validateEvidenceEntry(entry, `${label}[${index}]`, options);
    if (ids.has(entry.id)) {
      fail(`${label} contains duplicate id ${entry.id}.`);
    }
    ids.add(entry.id);
  }
}

function allCheckIds(contract) {
  return new Set(contract.automatedChecks.map((check) => check.id));
}

function evidenceBlockers(manifest, contract, verifiedCheckIds) {
  const blockers = [];
  const verified = new Set(verifiedCheckIds);
  const rowCheckIds = new Set();

  for (const row of manifest.rows) {
    for (const checkId of row.automatedChecks) {
      rowCheckIds.add(checkId);
      if (!verified.has(checkId)) {
        blockers.push(`${row.id}.automation.${checkId}`);
      }
    }
    for (const entry of row.manualEvidence) {
      if (entry.status !== 'verified') {
        blockers.push(`${row.id}.manual.${entry.id}`);
      }
    }
    for (const entry of row.exceptionEvidence) {
      if (entry.status !== 'verified') {
        blockers.push(`${row.id}.exception.${entry.id}`);
      }
    }
  }

  for (const checkId of allCheckIds(contract)) {
    if (!rowCheckIds.has(checkId) && !verified.has(checkId)) {
      blockers.push(`release.automation.${checkId}`);
    }
  }
  for (const entry of manifest.browserEvidence) {
    if (entry.status !== 'verified') {
      blockers.push(`browser.${entry.id}`);
    }
  }
  if (manifest.productConfirmation.status !== 'confirmed') {
    blockers.push('product-confirmation');
  }
  return blockers;
}

export function isReleaseChannel(channel) {
  return VALID_CHANNELS.has(channel);
}

export function validateReleaseEvidence(manifest, contract = readReleaseContract()) {
  if (!isRecord(manifest)) {
    fail('Release evidence must be an object.');
  }
  if (manifest.schemaVersion !== 2) {
    fail('Release evidence schemaVersion must be 2.');
  }
  if (!sameJson(manifest.baseline, contract.baseline)) {
    fail('Release evidence baseline must match the frozen v0.2.37 release contract.');
  }
  if (!isReleaseChannel(manifest.releaseStatus) || manifest.releaseStatus === 'auto') {
    fail('releaseStatus must be beta or complete.');
  }
  if (!isRecord(manifest.productConfirmation)) {
    fail('productConfirmation must be an object.');
  }
  if (!['confirmed', 'pending', 'unavailable'].includes(manifest.productConfirmation.status)) {
    fail('productConfirmation.status must be confirmed, pending, or unavailable.');
  }
  if (manifest.productConfirmation.status === 'confirmed') {
    requireEvidenceReference(manifest.productConfirmation.evidence, 'productConfirmation.evidence');
  } else {
    requireString(manifest.productConfirmation.reason, 'productConfirmation.reason');
  }

  requireArray(manifest.browserEvidence, 'browserEvidence');
  if (manifest.browserEvidence.length !== contract.requiredBrowserEvidence.length) {
    fail('browserEvidence must contain every frozen supported-browser record exactly once.');
  }
  for (const [index, expected] of contract.requiredBrowserEvidence.entries()) {
    const entry = manifest.browserEvidence[index];
    const label = `browserEvidence[${index}]`;
    if (!isRecord(entry) || entry.id !== expected.id) {
      fail(`${label} must be the required ${expected.id} browser record.`);
    }
    validateEvidenceEntry(entry, label, { type: 'manual', rowCheckIds: [] });
  }

  requireArray(manifest.rows, 'rows');
  if (manifest.rows.length !== contract.requiredRows.length) {
    fail('Release evidence must contain every frozen required matrix row exactly once.');
  }
  for (const [index, expected] of contract.requiredRows.entries()) {
    const row = manifest.rows[index];
    const label = `rows[${index}]`;
    if (!isRecord(row) || row.id !== expected.id || row.required !== true) {
      fail(`${label} must be the required ${expected.id} matrix row.`);
    }
    if (!sameJson(row.automatedChecks, expected.automatedChecks)) {
      fail(`${label}.automatedChecks must match the frozen ${expected.id} test plan.`);
    }
    requireArray(row.implementation, `${label}.implementation`);
    for (const [implementationIndex, implementation] of row.implementation.entries()) {
      requireString(implementation, `${label}.implementation[${implementationIndex}]`);
    }
    validateEvidenceList(row.manualEvidence, `${label}.manualEvidence`, {
      type: 'manual',
      rowCheckIds: expected.automatedChecks,
    });
    validateEvidenceList(row.exceptionEvidence, `${label}.exceptionEvidence`, {
      type: 'exception',
      rowCheckIds: expected.automatedChecks,
    });
  }

  if (manifest.releaseStatus === 'complete') {
    const blockers = evidenceBlockers(manifest, contract, allCheckIds(contract));
    if (blockers.length > 0) {
      fail(`releaseStatus complete has unresolved evidence: ${blockers.join(', ')}.`);
    }
  }
  return manifest;
}

export function readReleaseEvidence(
  manifestPath = defaultManifestPath,
  { contract = readReleaseContract(), root = repositoryRoot } = {},
) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    fail(`Unable to read release evidence ${manifestPath}: ${error.message}`);
  }
  validateReleaseEvidence(parsed, contract);
  validateRepositoryReferences(parsed, contract, { root });
  return parsed;
}

export function evaluateReleaseEvidence(manifest, {
  channel = 'beta',
  verifiedCheckIds = [],
  contract = readReleaseContract(),
} = {}) {
  validateReleaseEvidence(manifest, contract);
  if (!isReleaseChannel(channel)) {
    fail(`Unknown release channel ${channel}.`);
  }
  const blockers = evidenceBlockers(manifest, contract, verifiedCheckIds);
  const selectedChannel = channel === 'auto' ? manifest.releaseStatus : channel;
  const releaseTier = selectedChannel === 'complete'
    && manifest.releaseStatus === 'complete'
    && blockers.length === 0
    ? 'complete'
    : 'beta';

  return {
    baseline: manifest.baseline.version,
    requestedChannel: channel,
    declaredStatus: manifest.releaseStatus,
    releaseTier,
    blockers,
    rows: manifest.rows.map((row) => ({
      id: row.id,
      required: row.required,
      blockers: blockers.filter((blocker) => blocker.startsWith(`${row.id}.`)),
    })),
  };
}
