import fs from 'node:fs';
import path from 'node:path';

import { repositoryRoot } from './web-release-contract.mjs';

const CAPTURE_ARTIFACT_EXTENSION = /\.(?:jpe?g|png|webm|webp|mp4)$/iu;
const BROWSER_VERSION_PATTERN = /^(\d+)(?:\.\d+){1,3}$/u;

export function fail(message) {
  throw new Error(message);
}

export function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function requireString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    fail(`${label} must be a non-empty string.`);
  }
}

export function requireArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${label} must be a non-empty array.`);
  }
}

export function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function resolveRepositoryPath(root, relativePath, label) {
  requireString(relativePath, label);
  if (path.isAbsolute(relativePath)) {
    fail(`${label} must be repository-relative.`);
  }
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    fail(`${label} must stay inside the repository.`);
  }
  return resolved;
}

function readEvidenceRecord(reference, label, root) {
  const recordPath = resolveRepositoryPath(root, reference.record, `${label}.record`);
  if (!fs.existsSync(recordPath)) {
    fail(`${label}.record does not exist: ${reference.record}.`);
  }
  let record;
  try {
    record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  } catch (error) {
    fail(`Unable to read ${label}.record: ${error.message}`);
  }
  if (!isRecord(record) || record.schemaVersion !== 1) {
    fail(`${label}.record must be a schemaVersion 1 JSON object.`);
  }
  return record;
}

function validateCaptureArtifacts(record, label, root) {
  requireArray(record.artifacts, `${label}.record.artifacts`);
  for (const [index, artifact] of record.artifacts.entries()) {
    if (!CAPTURE_ARTIFACT_EXTENSION.test(artifact)) {
      fail(`${label}.record.artifacts[${index}] must be a screenshot or recording artifact.`);
    }
    const artifactPath = resolveRepositoryPath(root, artifact, `${label}.record.artifacts[${index}]`);
    if (!fs.existsSync(artifactPath) || fs.statSync(artifactPath).size === 0) {
      fail(`${label}.record.artifacts[${index}] must reference a non-empty artifact.`);
    }
  }
}

function browserMajor(version, label) {
  requireString(version, label);
  const match = BROWSER_VERSION_PATTERN.exec(version);
  if (!match) {
    fail(`${label} must be a dotted browser version.`);
  }
  const major = Number.parseInt(match[1], 10);
  if (!Number.isSafeInteger(major) || major < 1) {
    fail(`${label} must begin with a valid browser major.`);
  }
  return major;
}

function validateObservedAt(value, label, maxAgeDays) {
  requireString(value, label);
  if (!Number.isInteger(maxAgeDays) || maxAgeDays < 1) {
    fail('browserEvidencePolicy.maxEvidenceAgeDays must be a positive integer.');
  }
  const observedAt = new Date(value);
  if (Number.isNaN(observedAt.getTime()) || !value.endsWith('Z')) {
    fail(`${label} must be an ISO timestamp in UTC.`);
  }
  const age = Date.now() - observedAt.getTime();
  if (age < 0 || age > maxAgeDays * 24 * 60 * 60 * 1000) {
    fail(`${label} must be no more than ${maxAgeDays} days old.`);
  }
}

function validateManualRecord(entry, label, root, {
  expectedBrowserEvidence,
  browserEvidencePolicy,
  verifiedBrowserRecords,
} = {}) {
  const record = readEvidenceRecord(entry.evidence, label, root);
  if (record.kind !== 'manual' || record.id !== entry.id) {
    fail(`${label}.record must identify manual evidence ${entry.id}.`);
  }
  for (const field of ['browser', 'browserVersion', 'viewport', 'locale', 'theme', 'scenario']) {
    requireString(record[field], `${label}.record.${field}`);
  }
  validateCaptureArtifacts(record, label, root);

  if (expectedBrowserEvidence) {
    if (record.browser !== expectedBrowserEvidence.browser) {
      fail(`${label}.record.browser must be ${expectedBrowserEvidence.browser}.`);
    }
    requireString(record.browserChannel, `${label}.record.browserChannel`);
    if (record.browserChannel !== expectedBrowserEvidence.browserChannel) {
      fail(`${label}.record.browserChannel must be ${expectedBrowserEvidence.browserChannel}.`);
    }
    requireString(record.browserVersionRole, `${label}.record.browserVersionRole`);
    if (record.browserVersionRole !== expectedBrowserEvidence.browserVersionRole) {
      fail(`${label}.record.browserVersionRole must be ${expectedBrowserEvidence.browserVersionRole}.`);
    }
    requireString(record.supportScope, `${label}.record.supportScope`);
    if (record.supportScope !== expectedBrowserEvidence.supportScope) {
      fail(`${label}.record.supportScope must be ${expectedBrowserEvidence.supportScope}.`);
    }
    validateObservedAt(
      record.observedAt,
      `${label}.record.observedAt`,
      browserEvidencePolicy.maxEvidenceAgeDays,
    );
    requireArray(record.coverage, `${label}.record.coverage`);
    for (const flow of browserEvidencePolicy.representativeFlows) {
      if (!record.coverage.includes(flow)) {
        fail(`${label}.record.coverage must include ${flow}.`);
      }
    }
    return { ...record, major: browserMajor(record.browserVersion, `${label}.record.browserVersion`) };
  }

  if (verifiedBrowserRecords) {
    requireString(record.browserEvidenceId, `${label}.record.browserEvidenceId`);
    const supportedBrowser = verifiedBrowserRecords.get(record.browserEvidenceId);
    if (!supportedBrowser) {
      fail(`${label}.record.browserEvidenceId must reference a verified supported-browser record.`);
    }
    if (
      record.browser !== supportedBrowser.browser
      || record.browserVersion !== supportedBrowser.browserVersion
    ) {
      fail(`${label}.record must match browser evidence ${record.browserEvidenceId}.`);
    }
    requireString(record.supportScope, `${label}.record.supportScope`);
    if (record.supportScope !== supportedBrowser.supportScope) {
      fail(`${label}.record.supportScope must match browser evidence ${record.browserEvidenceId}.`);
    }
  }
  return record;
}

function validateBrowserMajorPairs(records, contract) {
  for (const browser of ['Chrome', 'Edge']) {
    const expectedRecords = contract.requiredBrowserEvidence.filter((entry) => entry.browser === browser);
    const latest = expectedRecords.find((entry) => entry.browserVersionRole === 'latest');
    const previous = expectedRecords.find((entry) => entry.browserVersionRole === 'previous');
    const latestRecord = latest && records.get(latest.id);
    const previousRecord = previous && records.get(previous.id);
    if (!latestRecord || !previousRecord) {
      continue;
    }
    if (latestRecord.major !== previousRecord.major + 1) {
      fail(`${browser} latest and previous evidence must use different adjacent browser majors.`);
    }
  }
}

function validateExceptionRecord(entry, label, root) {
  const record = readEvidenceRecord(entry.evidence, label, root);
  if (record.kind !== 'exception' || record.id !== entry.id) {
    fail(`${label}.record must identify exception evidence ${entry.id}.`);
  }
  if (!sameJson(record.checks, entry.checks)) {
    fail(`${label}.record.checks must exactly match the evidence checks.`);
  }
  for (const field of ['scenario', 'input', 'visibleError', 'recovery', 'sideEffects']) {
    requireString(record[field], `${label}.record.${field}`);
  }
  requireArray(record.testFiles, `${label}.record.testFiles`);
  for (const [index, testFile] of record.testFiles.entries()) {
    const testPath = resolveRepositoryPath(root, testFile, `${label}.record.testFiles[${index}]`);
    if (!fs.existsSync(testPath)) {
      fail(`${label}.record.testFiles[${index}] does not exist: ${testFile}.`);
    }
  }
}

function validateProductConfirmation(manifest, root) {
  if (manifest.productConfirmation.status !== 'confirmed') {
    return;
  }
  const record = readEvidenceRecord(manifest.productConfirmation.evidence, 'productConfirmation.evidence', root);
  if (record.kind !== 'product-confirmation' || record.id !== 'v0.2.37-complete-web-replacement') {
    fail('productConfirmation.evidence.record must identify the v0.2.37 product confirmation.');
  }
  for (const field of ['approver', 'approvedAt', 'scope']) {
    requireString(record[field], `productConfirmation.evidence.record.${field}`);
  }
  requireArray(record.artifacts, 'productConfirmation.evidence.record.artifacts');
  for (const [index, artifact] of record.artifacts.entries()) {
    const artifactPath = resolveRepositoryPath(root, artifact, `productConfirmation.evidence.record.artifacts[${index}]`);
    if (!fs.existsSync(artifactPath) || fs.statSync(artifactPath).size === 0) {
      fail(`productConfirmation.evidence.record.artifacts[${index}] must reference a non-empty artifact.`);
    }
  }
}

export function validateRepositoryReferences(manifest, contract, { root = repositoryRoot } = {}) {
  const matrixPath = resolveRepositoryPath(root, manifest.baseline.matrix, 'baseline.matrix');
  if (!fs.existsSync(matrixPath)) {
    fail(`Release evidence references a missing repository path: ${manifest.baseline.matrix}.`);
  }

  const verifiedBrowserRecords = new Map();
  for (const expected of contract.requiredBrowserEvidence) {
    const entry = manifest.browserEvidence.find((candidate) => candidate.id === expected.id);
    if (entry.status === 'verified') {
      verifiedBrowserRecords.set(
        entry.id,
        validateManualRecord(entry, `browserEvidence.${entry.id}`, root, {
          expectedBrowserEvidence: expected,
          browserEvidencePolicy: contract.browserEvidencePolicy,
        }),
      );
    }
  }
  validateBrowserMajorPairs(verifiedBrowserRecords, contract);

  for (const row of manifest.rows) {
    for (const implementation of row.implementation) {
      const implementationPath = resolveRepositoryPath(root, implementation, `${row.id}.implementation`);
      if (!fs.existsSync(implementationPath)) {
        fail(`Release evidence references a missing repository path: ${implementation}.`);
      }
    }
    for (const [index, entry] of row.manualEvidence.entries()) {
      if (entry.status === 'verified') {
        validateManualRecord(entry, `${row.id}.manualEvidence[${index}]`, root, {
          verifiedBrowserRecords,
        });
      }
    }
    for (const [index, entry] of row.exceptionEvidence.entries()) {
      if (entry.status === 'verified') {
        validateExceptionRecord(entry, `${row.id}.exceptionEvidence[${index}]`, root);
      }
    }
  }
  validateProductConfirmation(manifest, root);
  return contract;
}
