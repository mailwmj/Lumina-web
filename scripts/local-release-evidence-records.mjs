import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function fail(message) {
  throw new Error(message);
}

export function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function requireString(value, label) {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} must be a non-empty string.`);
}

export function requireArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) fail(`${label} must be a non-empty array.`);
}

function resolveRepositoryPath(root, reference, label) {
  requireString(reference, label);
  const resolved = path.resolve(root, reference);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) fail(`${label} must stay inside the repository.`);
  return resolved;
}

function validateArtifact(reference, label, root) {
  const artifactPath = resolveRepositoryPath(root, reference, label);
  if (!fs.existsSync(artifactPath)) fail(`${label} must reference a non-empty repository artifact.`);
  const artifact = fs.statSync(artifactPath);
  if (!artifact.isFile() || artifact.size === 0) fail(`${label} must reference a non-empty repository artifact.`);
  return artifactPath;
}

function validateObservedAt(value, label, maxAgeDays) {
  requireString(value, label);
  const observedAt = new Date(value);
  if (Number.isNaN(observedAt.getTime()) || !value.endsWith('Z')) fail(`${label} must be an ISO UTC timestamp.`);
  const age = Date.now() - observedAt.getTime();
  if (age < 0 || age > maxAgeDays * 24 * 60 * 60 * 1000) fail(`${label} must be no more than ${maxAgeDays} days old.`);
}

function validateObservations(record, required, label, root) {
  requireArray(record.observations, `${label}.observations`);
  if (!sameJson(record.observations.map((observation) => observation.id), required.requiredObservations)) {
    fail(`${label}.observations must include every required observation in order.`);
  }
  for (const [index, observation] of record.observations.entries()) {
    if (!isRecord(observation) || observation.outcome !== 'passed') {
      fail(`${label}.observations[${index}] must record a passed observation.`);
    }
    requireString(observation.detail, `${label}.observations[${index}].detail`);
    requireArray(observation.artifacts, `${label}.observations[${index}].artifacts`);
    for (const [artifactIndex, artifact] of observation.artifacts.entries()) {
      validateArtifact(artifact, `${label}.observations[${index}].artifacts[${artifactIndex}]`, root);
    }
  }
}

function validateSignature(record, label, root) {
  if (!isRecord(record.signatureVerification) || record.signatureVerification.status !== 'verified') {
    fail(`${label}.signatureVerification must record a verified signature result.`);
  }
  for (const field of ['tool', 'command', 'signer']) {
    requireString(record.signatureVerification[field], `${label}.signatureVerification.${field}`);
  }
  requireArray(record.signatureVerification.artifacts, `${label}.signatureVerification.artifacts`);
  for (const [index, artifact] of record.signatureVerification.artifacts.entries()) {
    validateArtifact(artifact, `${label}.signatureVerification.artifacts[${index}]`, root);
  }
}

function validateNotarization(record, label, root) {
  if (!isRecord(record.notarizationVerification) || record.notarizationVerification.status !== 'verified') {
    fail(`${label}.notarizationVerification must record a verified notarization result.`);
  }
  for (const field of ['tool', 'command']) {
    requireString(record.notarizationVerification[field], `${label}.notarizationVerification.${field}`);
  }
  requireArray(record.notarizationVerification.artifacts, `${label}.notarizationVerification.artifacts`);
  for (const [index, artifact] of record.notarizationVerification.artifacts.entries()) {
    validateArtifact(artifact, `${label}.notarizationVerification.artifacts[${index}]`, root);
  }
}

function validateInstaller(record, required, label, root) {
  requireString(record.installerArtifact, `${label}.installerArtifact`);
  const installerPath = validateArtifact(record.installerArtifact, `${label}.installerArtifact`, root);
  if (path.extname(installerPath).toLowerCase() !== required.installerExtension) {
    fail(`${label}.installerArtifact must be a ${required.installerExtension} package.`);
  }
  if (!/^[a-f0-9]{64}$/iu.test(record.installerSha256)) {
    fail(`${label}.installerSha256 must be a SHA-256 hex digest.`);
  }
  const digest = createHash('sha256').update(fs.readFileSync(installerPath)).digest('hex');
  if (record.installerSha256.toLowerCase() !== digest) {
    fail(`${label}.installerSha256 must match the referenced installer SHA-256.`);
  }
  validateSignature(record, label, root);
  if (required.requiresNotarization) validateNotarization(record, label, root);
}

export function validateManualEvidenceRecord({ entry, required, maxAgeDays, root }) {
  const label = `${entry.id}.evidence.record`;
  if (!isRecord(entry.evidence) || Object.keys(entry.evidence).length !== 1) {
    fail(`${entry.id}.evidence must contain only a record path.`);
  }
  const recordPath = resolveRepositoryPath(root, entry.evidence.record, `${entry.id}.evidence.record`);
  if (!fs.existsSync(recordPath)) fail(`${entry.id}.evidence.record does not exist: ${entry.evidence.record}.`);
  let record;
  try {
    record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  } catch (error) {
    fail(`Unable to read ${entry.id}.evidence.record: ${error.message}`);
  }
  if (!isRecord(record) || record.schemaVersion !== 1 || record.kind !== 'local-release-manual') {
    fail(`${label} must be a schemaVersion 1 local-release-manual record.`);
  }
  if (record.id !== required.id || record.platform !== required.platform) {
    fail(`${label} must identify the required platform evidence.`);
  }
  for (const field of ['releaseVersion', 'osVersion', 'architecture']) {
    requireString(record[field], `${label}.${field}`);
  }
  if (required.architecture && record.architecture !== required.architecture) {
    fail(`${label}.architecture must be ${required.architecture}.`);
  }
  validateObservedAt(record.observedAt, `${label}.observedAt`, maxAgeDays);
  requireArray(record.coverage, `${label}.coverage`);
  for (const scenario of required.coverage) {
    if (!record.coverage.includes(scenario)) fail(`${label}.coverage must include ${scenario}.`);
  }
  validateObservations(record, required, label, root);
  if (required.requiresSignedArtifact) {
    validateInstaller(record, required, label, root);
  } else {
    requireString(record.provider, `${label}.provider`);
    requireString(record.model, `${label}.model`);
    if (record.usedLocalWeights !== false) fail(`${label}.usedLocalWeights must be false.`);
  }
}
