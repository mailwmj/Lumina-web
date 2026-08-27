import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseBridgeProtocol } from '../runtime/bridgeProtocol.mjs';
import { assertSupportedPackagingTarget, releaseRequirementsFor } from './packagingTarget.mjs';
import { generateMacIcon, generateWindowsIcon } from './iconAssets.mjs';

const defaultPluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'lumina-canvas');
const defaultIconSource = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'app-icon-selected-1024.png');
const pluginFiles = [
  ['.codex-plugin', 'plugin.json'],
  ['.mcp.json'],
  ['README.md'],
  ['scripts', 'launch-installed-runtime.mjs'],
];

export async function prepareInstaller(options) {
  const settings = validateOptions(options);
  const stageDirectory = path.join(settings.outputDirectory, `${settings.platform}-${settings.arch}`);
  await fs.rm(stageDirectory, { recursive: true, force: true });
  if (settings.platform === 'win32') {
    await prepareWindowsInstaller(stageDirectory, settings);
  } else {
    await prepareMacInstaller(stageDirectory, settings);
  }
  return {
    stageDirectory,
    nativeRequirements: releaseRequirementsFor(settings.platform),
  };
}

function validateOptions(options) {
  if (!options || typeof options !== 'object') {
    throw new Error('Lumina installer packaging requires options.');
  }
  const {
    platform,
    arch,
    version,
    runtimeExecutable,
    webRoot,
    outputDirectory,
    bridgeProtocol,
    pluginRoot = defaultPluginRoot,
    iconSource = defaultIconSource,
  } = options;
  assertSupportedPackagingTarget(platform, arch, 'installer packaging');
  for (const [name, value] of Object.entries({ version, runtimeExecutable, webRoot, outputDirectory, pluginRoot, iconSource })) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`Lumina installer packaging requires ${name}.`);
    }
  }
  return {
    platform,
    arch,
    version,
    runtimeExecutable: path.resolve(runtimeExecutable),
    webRoot: path.resolve(webRoot),
    outputDirectory: path.resolve(outputDirectory),
    pluginRoot: path.resolve(pluginRoot),
    iconSource: path.resolve(iconSource),
    bridgeProtocol: parseBridgeProtocol(
      bridgeProtocol,
      'Lumina installer packaging requires a valid canvas bridge protocol.',
    ),
  };
}

async function prepareWindowsInstaller(stageDirectory, settings) {
  const appDirectory = path.join(stageDirectory, 'app');
  await generateWindowsIcon(settings.iconSource, path.join(stageDirectory, 'Lumina.ico'));
  await copyRuntimePayload(settings, appDirectory, 'LuminaRuntime.exe');
  await copyCodexPluginPayload(settings, path.join(appDirectory, 'Lumina-Codex-Plugin'));
  await fs.writeFile(path.join(appDirectory, 'LuminaProtocol.vbs'), windowsProtocolLauncher(), 'utf8');
  await fs.writeFile(path.join(stageDirectory, 'Lumina.url'), '[InternetShortcut]\r\nURL=lumina://open\r\n', 'utf8');
  await fs.writeFile(path.join(stageDirectory, 'Lumina.iss'), windowsInstallerScript(settings, stageDirectory), 'utf8');
}

async function prepareMacInstaller(stageDirectory, settings) {
  const appRoot = path.join(stageDirectory, 'payload', 'Applications', 'Lumina.app', 'Contents');
  const macOsDirectory = path.join(appRoot, 'MacOS');
  const resourcesDirectory = path.join(appRoot, 'Resources');
  await copyRuntimePayload(settings, macOsDirectory, 'LuminaRuntime');
  await fs.mkdir(resourcesDirectory, { recursive: true });
  await generateMacIcon(settings.iconSource, path.join(resourcesDirectory, 'Lumina.icns'));
  await fs.rename(path.join(macOsDirectory, 'web'), path.join(resourcesDirectory, 'web'));
  await copyCodexPluginPayload(settings, path.join(resourcesDirectory, 'Lumina-Codex-Plugin'));
  await fs.chmod(path.join(macOsDirectory, 'LuminaRuntime'), 0o755);
  await fs.writeFile(path.join(appRoot, 'Info.plist'), macInfoPlist(settings), 'utf8');
  await fs.writeFile(path.join(stageDirectory, 'payload', 'Applications', 'Lumina.webloc'), macBookmark(), 'utf8');
  await fs.mkdir(path.join(stageDirectory, 'scripts'), { recursive: true });
  await fs.writeFile(path.join(stageDirectory, 'scripts', 'preinstall'), macPreinstallScript(), { encoding: 'utf8', mode: 0o755 });
  await fs.writeFile(path.join(stageDirectory, 'scripts', 'postinstall'), macPostinstallScript(), { encoding: 'utf8', mode: 0o755 });
  await fs.writeFile(path.join(stageDirectory, 'Distribution.xml'), macDistribution(settings), 'utf8');
}

async function copyRuntimePayload(settings, targetDirectory, runtimeName) {
  await fs.mkdir(targetDirectory, { recursive: true });
  await fs.access(settings.runtimeExecutable);
  await fs.access(path.join(settings.webRoot, 'index.html'));
  await fs.copyFile(settings.runtimeExecutable, path.join(targetDirectory, runtimeName));
  await fs.cp(settings.webRoot, path.join(targetDirectory, 'web'), { recursive: true });
  await fs.writeFile(path.join(targetDirectory, 'runtime-version.json'), JSON.stringify({
    version: settings.version,
    bridgeProtocol: settings.bridgeProtocol,
  }), 'utf8');
}

async function copyCodexPluginPayload(settings, targetDirectory) {
  const manifestPath = path.join(settings.pluginRoot, '.codex-plugin', 'plugin.json');
  const mcpPath = path.join(settings.pluginRoot, '.mcp.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const mcp = JSON.parse(await fs.readFile(mcpPath, 'utf8'));
  assert.equal(manifest.name, 'lumina-canvas', 'Lumina installer packaging requires the lumina-canvas plugin.');
  assert.equal(typeof manifest.version, 'string', 'Lumina installer packaging requires a plugin version.');
  assert.equal(compatibilityLine(manifest.version), compatibilityLine(settings.version), 'Lumina plugin and runtime versions must share a major/minor compatibility line.');
  assert.equal(mcp.mcpServers?.['lumina-canvas']?.command, 'node', 'Lumina plugin MCP configuration must use the supported Node launcher.');
  assert.deepEqual(mcp.mcpServers['lumina-canvas'].args, ['./scripts/launch-installed-runtime.mjs']);

  await fs.rm(targetDirectory, { recursive: true, force: true });
  await fs.mkdir(targetDirectory, { recursive: true });
  for (const relativeParts of pluginFiles) {
    const relativePath = path.join(...relativeParts);
    const sourcePath = path.join(settings.pluginRoot, relativePath);
    const destinationPath = path.join(targetDirectory, relativePath);
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.copyFile(sourcePath, destinationPath);
  }
  const skillsSource = path.join(settings.pluginRoot, 'skills');
  await fs.cp(skillsSource, path.join(targetDirectory, 'skills'), { recursive: true });
}

function compatibilityLine(version) {
  const match = /^(\d+)\.(\d+)(?:\.|$)/u.exec(version.trim());
  if (!match) throw new Error(`Lumina installer packaging requires a valid compatibility version, received ${version}.`);
  return `${match[1]}.${match[2]}`;
}

function windowsProtocolLauncher() {
  return [
    'Set shell = CreateObject("WScript.Shell")',
    'runtime = Replace(WScript.ScriptFullName, "LuminaProtocol.vbs", "LuminaRuntime.exe")',
    'arguments = ""',
    'For Each argument In WScript.Arguments',
    '  arguments = arguments & " " & Chr(34) & Replace(argument, Chr(34), Chr(34) & Chr(34)) & Chr(34)',
    'Next',
    'shell.Run Chr(34) & runtime & Chr(34) & arguments, 0, False',
  ].join('\r\n');
}

function windowsInstallerScript(settings, stageDirectory) {
  const source = '{#StagingRoot}\\app\\*';
  return [
    '#define MyAppName "Lumina"',
    `#define MyAppVersion "${settings.version}"`,
    `#define StagingRoot "${stageDirectory.replaceAll('"', '""')}"`,
    '[Setup]',
    'AppId={{A16E4C45-EB1C-4E7D-9AA8-6F86AB8DC28E}',
    'AppName={#MyAppName}',
    'AppVersion={#MyAppVersion}',
    'DefaultDirName={localappdata}\\Lumina',
    'DisableProgramGroupPage=yes',
    'PrivilegesRequired=lowest',
    'CloseApplications=yes',
    'CloseApplicationsFilter=LuminaRuntime.exe',
    'RestartApplications=no',
    `ArchitecturesAllowed=${settings.arch === 'arm64' ? 'arm64' : 'x64compatible'}`,
    `ArchitecturesInstallIn64BitMode=${settings.arch === 'arm64' ? 'arm64' : 'x64compatible'}`,
    'OutputDir={#StagingRoot}\\release',
    'OutputBaseFilename=Lumina-Setup',
    'SetupIconFile={#StagingRoot}\\Lumina.ico',
    'UninstallDisplayIcon={app}\\LuminaRuntime.exe',
    '[Files]',
    `Source: "${source}"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs`,
    'Source: "{#StagingRoot}\\Lumina.url"; DestDir: "{userdesktop}"; Flags: onlyifdoesntexist',
    '[Icons]',
    'Name: "{autodesktop}\\Lumina"; Filename: "{sys}\\wscript.exe"; Parameters: """{app}\\LuminaProtocol.vbs"" ""lumina://open"""; WorkingDir: "{app}"; IconFilename: "{app}\\LuminaRuntime.exe"; Flags: createonlyiffileexists',
    '[Registry]',
    'Root: HKCU; Subkey: "Software\\Classes\\lumina"; ValueType: string; ValueName: ""; ValueData: "URL:Lumina Protocol"; Flags: uninsdeletekey',
    'Root: HKCU; Subkey: "Software\\Classes\\lumina"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""',
    'Root: HKCU; Subkey: "Software\\Classes\\lumina\\shell\\open\\command"; ValueType: string; ValueName: ""; ValueData: "wscript.exe ""{app}\\LuminaProtocol.vbs"" ""%1"""',
    '[Code]',
    'procedure WriteRuntimeLocator;',
    'var',
    '  LocatorDirectory: String;',
    '  LocatorPath: String;',
    '  RuntimePath: String;',
    'begin',
    "  LocatorDirectory := ExpandConstant('{userappdata}\\Lumina\\runtime');",
    "  LocatorPath := LocatorDirectory + '\\runtime-location.txt';",
    "  RuntimePath := ExpandConstant('{app}\\LuminaRuntime.exe');",
    '  if not ForceDirectories(LocatorDirectory) then',
    "    RaiseException('Lumina could not create its installation locator. Run Repair or contact support.');",
    '  if not SaveStringToFile(LocatorPath, RuntimePath + #13#10, False) then',
    "    RaiseException('Lumina could not record its installation location. Run Repair or contact support.');",
    'end;',
    '',
    'procedure CurStepChanged(CurStep: TSetupStep);',
    'var',
    '  ProtocolCommand: String;',
    'begin',
    '  if CurStep = ssPostInstall then',
    '  begin',
    '    WriteRuntimeLocator;',
    "    if not RegQueryStringValue(HKCU, 'Software\\Classes\\lumina\\shell\\open\\command', '', ProtocolCommand) then",
    "      MsgBox('Lumina could not register lumina:// links. Run the installer again or contact support.', mbError, MB_OK);",
    '  end;',
    'end;',
  ].join('\r\n');
}

function macInfoPlist(settings) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleDisplayName</key><string>Lumina</string>
<key>CFBundleExecutable</key><string>LuminaRuntime</string>
<key>CFBundleIdentifier</key><string>com.lumina.runtime</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${settings.version}</string>
<key>CFBundleVersion</key><string>${settings.version}</string>
<key>CFBundleIconFile</key><string>Lumina.icns</string>
<key>LSUIElement</key><true/>
<key>CFBundleURLTypes</key><array><dict>
<key>CFBundleURLName</key><string>com.lumina.open</string>
<key>CFBundleURLSchemes</key><array><string>lumina</string></array>
</dict></array>
</dict></plist>`;
}

function macBookmark() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>URL</key><string>lumina://open</string></dict></plist>`;
}

function macPreinstallScript() {
  return `#!/bin/sh
set -eu
locator="/Library/Application Support/Lumina/runtime/runtime-location.txt"
target_volume="\${3:-/}"
runtime="\${target_volume%/}/Applications/Lumina.app/Contents/MacOS/LuminaRuntime"
if [ -f "$locator" ]; then
  registered_runtime="$(/usr/bin/head -n 1 "$locator")"
  if [ -n "$registered_runtime" ]; then
    runtime="$registered_runtime"
  fi
fi
if [ ! -x "$runtime" ]; then
  exit 0
fi
/usr/bin/pkill -TERM -f "$runtime" || true
attempt=0
while /usr/bin/pgrep -f "$runtime" >/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 10 ]; then
    echo "Lumina is still running. Close Lumina and run Repair again." >&2
    exit 1
  fi
  /bin/sleep 1
done
`;
}

function macPostinstallScript() {
  return `#!/bin/sh
set -eu
target_volume="\${3:-/}"
application="\${target_volume%/}/Applications/Lumina.app"
runtime="$application/Contents/MacOS/LuminaRuntime"
locator_directory="/Library/Application Support/Lumina/runtime"
locator="$locator_directory/runtime-location.txt"
if ! /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$application"; then
  echo "Lumina could not register lumina links. Run the installer again or contact support." >&2
  exit 1
fi
if ! /bin/mkdir -p "$locator_directory"; then
  echo "Lumina could not create its installation locator. Run Repair or contact support." >&2
  exit 1
fi
if ! printf '%s\\n' "$runtime" > "$locator"; then
  echo "Lumina could not record its installation location. Run Repair or contact support." >&2
  exit 1
fi
/bin/chmod 0644 "$locator"
`;
}

function macDistribution(settings) {
  return `<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="1"><title>Lumina</title><options customize="never" require-scripts="false"/><choices-outline><line choice="default"/></choices-outline><choice id="default" visible="false"><pkg-ref id="com.lumina.runtime"/></choice><pkg-ref id="com.lumina.runtime" version="${settings.version}" onConclusion="none">Lumina.pkg</pkg-ref></installer-gui-script>`;
}
