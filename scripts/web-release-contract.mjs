import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

export const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export const defaultReleaseContractPath = path.join(
  repositoryRoot,
  'docs',
  'migration',
  'v0.2.37-release-contract.json',
);

const frozenContract = {
  schemaVersion: 1,
  baseline: {
    version: 'v0.2.37',
    commit: '77e6d1e',
    matrix: 'docs/migration/v0.2.37-equivalence-matrix.md',
  },
  browserEvidencePolicy: {
    maxEvidenceAgeDays: 35,
    representativeFlows: ['project', 'assets', 'generation', 'import-export', 'offline'],
  },
  requiredBrowserEvidence: [
    {
      id: 'chrome-latest',
      browser: 'Chrome',
      browserChannel: 'stable',
      browserVersionRole: 'latest',
      supportScope: 'web-renderer-compatibility',
    },
    {
      id: 'chrome-previous',
      browser: 'Chrome',
      browserChannel: 'stable',
      browserVersionRole: 'previous',
      supportScope: 'web-renderer-compatibility',
    },
    {
      id: 'edge-latest',
      browser: 'Edge',
      browserChannel: 'stable',
      browserVersionRole: 'latest',
      supportScope: 'web-renderer-compatibility',
    },
    {
      id: 'edge-previous',
      browser: 'Edge',
      browserChannel: 'stable',
      browserVersionRole: 'previous',
      supportScope: 'web-renderer-compatibility',
    },
    {
      id: 'connected-chrome-codex-entry',
      browser: 'Connected Chrome',
      browserChannel: 'connected-chrome',
      browserVersionRole: 'representative',
      supportScope: 'pre-cutover-connected-chrome-shared-library-codex',
    },
  ],
  automatedChecks: [
    { id: 'typecheck', command: ['npx', 'tsc', '--noEmit'] },
    { id: 'web-only-contract', command: ['npm', 'run', 'test:web-only'] },
    { id: 'release-gate-contract', command: ['npm', 'run', 'test:release-gate'] },
    { id: 'vitest', command: ['npx', 'vitest', 'run'] },
    { id: 'gateway', command: ['npx', 'vitest', 'run', 'gateway'] },
    { id: 'canvas-agent', command: ['npm', 'run', 'canvas-agent:test'] },
    {
      id: 'plugin-discovery',
      command: ['node', '--test', 'plugins/lumina-canvas/plugin.node-test.mjs'],
    },
    {
      id: 'dependency-audit',
      command: ['npm', 'audit', '--omit=dev', '--audit-level=high'],
    },
    {
      id: 'scoped-lint',
      command: [
        'npx',
        'eslint',
        'playwright.config.ts',
        'scripts/web-release-contract.mjs',
        'scripts/web-release-evidence.mjs',
        'scripts/web-release-evidence-records.mjs',
        'scripts/web-release-gate.mjs',
        'scripts/web-release-gate.node-test.mjs',
        'scripts/web-artifact-contract.node-test.mjs',
      ],
    },
    { id: 'build', command: ['npm', 'run', 'build'] },
    {
      id: 'artifact-contract',
      command: ['node', '--test', 'scripts/web-artifact-contract.node-test.mjs'],
    },
    {
      id: 'e2e-production-chromium',
      command: ['npm', 'run', 'test:e2e'],
      environment: {
        LUMINA_E2E_BROWSER: 'chromium',
        LUMINA_E2E_PORT: '4287',
        LUMINA_E2E_REUSE_EXISTING_SERVER: 'false',
        LUMINA_E2E_SERVER_COMMAND: 'npm run preview -- --host 127.0.0.1 --port 4287',
      },
    },
  ],
  requiredRows: [
    {
      id: 'project',
      matrixDomain: '项目',
      automatedChecks: ['typecheck', 'vitest', 'e2e-production-chromium'],
    },
    {
      id: 'canvas',
      matrixDomain: '画布',
      automatedChecks: ['typecheck', 'vitest', 'e2e-production-chromium'],
    },
    {
      id: 'image',
      matrixDomain: '图片',
      automatedChecks: ['typecheck', 'vitest', 'gateway', 'e2e-production-chromium'],
    },
    {
      id: 'storyboard',
      matrixDomain: '分镜',
      automatedChecks: ['typecheck', 'vitest', 'e2e-production-chromium'],
    },
    {
      id: 'text',
      matrixDomain: '文本',
      automatedChecks: ['typecheck', 'vitest'],
    },
    {
      id: 'video',
      matrixDomain: '视频',
      automatedChecks: ['typecheck', 'vitest', 'e2e-production-chromium'],
    },
    {
      id: 'batch-crop',
      matrixDomain: '批量裁图',
      automatedChecks: ['typecheck', 'vitest', 'e2e-production-chromium'],
    },
    {
      id: 'settings',
      matrixDomain: '设置',
      automatedChecks: ['typecheck', 'vitest', 'e2e-production-chromium'],
    },
    {
      id: 'codex',
      matrixDomain: 'Codex',
      automatedChecks: ['typecheck', 'canvas-agent', 'plugin-discovery', 'e2e-production-chromium'],
    },
  ],
};

function fail(message) {
  throw new Error(message);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    fail(`${label} must be a non-empty string.`);
  }
}

function requireArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${label} must be a non-empty array.`);
  }
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function readMatrixDomains(matrixPath) {
  const lines = fs.readFileSync(matrixPath, 'utf8').split(/\r?\n/u);
  const headerIndex = lines.findIndex((line) => line.trim().startsWith('| 领域 |'));
  if (headerIndex === -1 || !lines[headerIndex + 1]?.trim().startsWith('| ---')) {
    fail('The frozen equivalence matrix table is missing its domain header.');
  }

  const domains = [];
  for (const line of lines.slice(headerIndex + 2)) {
    if (!line.trim().startsWith('|')) {
      break;
    }
    const cells = line.split('|');
    const domain = cells[1]?.trim();
    if (!domain) {
      fail('The frozen equivalence matrix contains an empty domain.');
    }
    domains.push(domain);
  }
  return domains;
}

export function validateReleaseContract(contract, { root = repositoryRoot } = {}) {
  if (!isRecord(contract)) {
    fail('Release contract must be an object.');
  }
  if (!sameJson(contract, frozenContract)) {
    fail('Release contract differs from the frozen v0.2.37 required matrix and test plan.');
  }

  requireArray(contract.automatedChecks, 'automatedChecks');
  for (const [index, check] of contract.automatedChecks.entries()) {
    const label = `automatedChecks[${index}]`;
    if (!isRecord(check)) {
      fail(`${label} must be an object.`);
    }
    requireString(check.id, `${label}.id`);
    requireArray(check.command, `${label}.command`);
    for (const [commandIndex, value] of check.command.entries()) {
      requireString(value, `${label}.command[${commandIndex}]`);
    }
  }

  const matrixPath = path.join(root, contract.baseline.matrix);
  if (!fs.existsSync(matrixPath)) {
    fail(`Frozen equivalence matrix is missing: ${contract.baseline.matrix}.`);
  }
  const matrixDomains = readMatrixDomains(matrixPath);
  const contractDomains = contract.requiredRows.map((row) => row.matrixDomain);
  if (!sameJson(matrixDomains, contractDomains)) {
    fail('Release contract row domains no longer match the frozen equivalence matrix.');
  }

  return contract;
}

export function readReleaseContract(contractPath = defaultReleaseContractPath, { root = repositoryRoot } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  } catch (error) {
    fail(`Unable to read release contract ${contractPath}: ${error.message}`);
  }
  return validateReleaseContract(parsed, { root });
}
