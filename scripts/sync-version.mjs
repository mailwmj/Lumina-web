#!/usr/bin/env node

import { execSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";

const VERSION_PATTERN =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function resolveRepoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export function syncPluginVersion(repoRoot, nextVersion) {
  const manifestPath = path.join(
    repoRoot,
    "plugins",
    "lumina-canvas",
    ".codex-plugin",
    "plugin.json",
  );
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.name !== "lumina-canvas") {
    throw new Error("Lumina version sync requires the lumina-canvas plugin manifest.");
  }
  manifest.version = nextVersion;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function main() {
  const args = process.argv.slice(2);
  const nextVersion = args[0];

  if (!nextVersion) {
    fail("Usage: npm run sync:version -- <version>");
  }

  if (!VERSION_PATTERN.test(nextVersion)) {
    fail(`Invalid semver version: ${nextVersion}`);
  }

  const repoRoot = resolveRepoRoot();
  process.chdir(repoRoot);

  execSync(`npm version ${nextVersion} --no-git-tag-version --allow-same-version`, {
    stdio: "inherit",
  });
  syncPluginVersion(repoRoot, nextVersion);

  console.log(`Synchronized version to ${nextVersion}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
