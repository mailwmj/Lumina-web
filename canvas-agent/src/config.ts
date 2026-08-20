import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_PORT = 17372;
export const CONFIG_DIR = path.join(os.homedir(), '.lumina');
export const CONFIG_FILE = path.join(CONFIG_DIR, 'canvas-agent.json');

export interface CanvasAgentConfig {
  url: string;
  token: string;
  origins: string[];
}

const DEFAULT_ORIGINS = [
  'http://127.0.0.1:1420',
  'http://localhost:1420',
  'http://tauri.localhost',
  'https://tauri.localhost',
  'tauri://localhost',
];

function createDefaultConfig(): CanvasAgentConfig {
  const configuredPort = Number(process.env.PORT);
  const port = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65_535
    ? configuredPort
    : DEFAULT_PORT;
  return {
    url: `http://127.0.0.1:${port}`,
    token: crypto.randomBytes(32).toString('hex'),
    origins: DEFAULT_ORIGINS,
  };
}

function normalizeConfig(value: unknown): CanvasAgentConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const url = typeof record.url === 'string' ? record.url.trim() : '';
  const token = typeof record.token === 'string' ? record.token.trim() : '';
  try {
    const parsedUrl = new URL(url);
    if (
      parsedUrl.protocol !== 'http:'
      || parsedUrl.hostname !== '127.0.0.1'
      || parsedUrl.username
      || parsedUrl.password
      || parsedUrl.pathname !== '/'
      || parsedUrl.search
      || parsedUrl.hash
    ) {
      return null;
    }
  } catch {
    return null;
  }
  if (token.length < 32) {
    return null;
  }
  const origins = Array.isArray(record.origins)
    ? record.origins.filter((origin): origin is string => typeof origin === 'string')
    : DEFAULT_ORIGINS;
  return {
    url: new URL(url).origin,
    token,
    origins: [...new Set([...DEFAULT_ORIGINS, ...origins])],
  };
}

export function loadConfig(create = false, configFile?: string): CanvasAgentConfig {
  const resolvedConfigFile = resolveConfigFile(configFile);
  try {
    const parsed = JSON.parse(fs.readFileSync(resolvedConfigFile, 'utf8')) as unknown;
    const normalized = normalizeConfig(parsed);
    if (normalized) {
      return normalized;
    }
  } catch {
    // The first start creates a new owner-local configuration below.
  }

  const config = createDefaultConfig();
  if (create) {
    saveConfig(config, resolvedConfigFile);
  }
  return config;
}

export function saveConfig(config: CanvasAgentConfig, configFile?: string): void {
  const resolvedConfigFile = resolveConfigFile(configFile);
  fs.mkdirSync(path.dirname(resolvedConfigFile), { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(path.dirname(resolvedConfigFile), 0o700);
  } catch {
    // Windows does not implement POSIX file modes; the directory remains user-local.
  }
  fs.writeFileSync(resolvedConfigFile, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  try {
    fs.chmodSync(resolvedConfigFile, 0o600);
  } catch {
    // Windows does not implement POSIX file modes; the file remains user-local.
  }
}

function resolveConfigFile(configFile?: string): string {
  const configuredPath = configFile?.trim() || process.env.LUMINA_CANVAS_AGENT_CONFIG?.trim();
  return configuredPath ? path.resolve(configuredPath) : CONFIG_FILE;
}
