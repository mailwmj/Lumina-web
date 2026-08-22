import fs from 'node:fs/promises';
import path from 'node:path';

const supportedPlatforms = new Set(['win32', 'darwin']);
const supportedArchitectures = new Set(['x64', 'arm64']);

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
    nativeRequirements: settings.platform === 'win32'
      ? ['ISCC.exe', 'signtool.exe']
      : ['codesign', 'pkgbuild', 'productbuild', 'xcrun notarytool'],
  };
}

function validateOptions(options) {
  if (!options || typeof options !== 'object') {
    throw new Error('Lumina installer packaging requires options.');
  }
  const { platform, arch, version, runtimeExecutable, webRoot, outputDirectory } = options;
  if (!supportedPlatforms.has(platform)) {
    throw new Error('Lumina installer packaging supports only Windows and macOS.');
  }
  if (!supportedArchitectures.has(arch)) {
    throw new Error('Lumina installer packaging supports x64 and arm64.');
  }
  for (const [name, value] of Object.entries({ version, runtimeExecutable, webRoot, outputDirectory })) {
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
  };
}

async function prepareWindowsInstaller(stageDirectory, settings) {
  const appDirectory = path.join(stageDirectory, 'app');
  await copyRuntimePayload(settings, appDirectory, 'LuminaRuntime.exe');
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
  await fs.rename(path.join(macOsDirectory, 'web'), path.join(resourcesDirectory, 'web'));
  await fs.chmod(path.join(macOsDirectory, 'LuminaRuntime'), 0o755);
  await fs.writeFile(path.join(appRoot, 'Info.plist'), macInfoPlist(settings), 'utf8');
  await fs.writeFile(path.join(stageDirectory, 'payload', 'Applications', 'Lumina.webloc'), macBookmark(), 'utf8');
  await fs.mkdir(path.join(stageDirectory, 'scripts'), { recursive: true });
  await fs.writeFile(path.join(stageDirectory, 'scripts', 'postinstall'), macPostinstallScript(), { encoding: 'utf8', mode: 0o755 });
  await fs.writeFile(path.join(stageDirectory, 'Distribution.xml'), macDistribution(settings), 'utf8');
}

async function copyRuntimePayload(settings, targetDirectory, runtimeName) {
  await fs.mkdir(targetDirectory, { recursive: true });
  await fs.access(settings.runtimeExecutable);
  await fs.access(path.join(settings.webRoot, 'index.html'));
  await fs.copyFile(settings.runtimeExecutable, path.join(targetDirectory, runtimeName));
  await fs.cp(settings.webRoot, path.join(targetDirectory, 'web'), { recursive: true });
  await fs.writeFile(path.join(targetDirectory, 'runtime-version.json'), JSON.stringify({ version: settings.version }), 'utf8');
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
    `ArchitecturesAllowed=${settings.arch === 'arm64' ? 'arm64' : 'x64compatible'}`,
    `ArchitecturesInstallIn64BitMode=${settings.arch === 'arm64' ? 'arm64' : 'x64compatible'}`,
    'OutputDir={#StagingRoot}\\release',
    'OutputBaseFilename=Lumina-Setup',
    '[Files]',
    `Source: "${source}"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs`,
    'Source: "{#StagingRoot}\\Lumina.url"; DestDir: "{userdesktop}"; Flags: onlyifdoesntexist',
    '[Registry]',
    'Root: HKCU; Subkey: "Software\\Classes\\lumina"; ValueType: string; ValueName: ""; ValueData: "URL:Lumina Protocol"; Flags: uninsdeletekey',
    'Root: HKCU; Subkey: "Software\\Classes\\lumina"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""',
    'Root: HKCU; Subkey: "Software\\Classes\\lumina\\shell\\open\\command"; ValueType: string; ValueName: ""; ValueData: "wscript.exe ""{app}\\LuminaProtocol.vbs"" ""%1"""',
    '[Code]',
    'procedure CurStepChanged(CurStep: TSetupStep);',
    'var',
    '  ProtocolCommand: String;',
    'begin',
    "  if (CurStep = ssPostInstall) and (not RegQueryStringValue(HKCU, 'Software\\Classes\\lumina\\shell\\open\\command', '', ProtocolCommand)) then",
    '  begin',
    "    MsgBox('Lumina could not register lumina:// links. Run the installer again or contact support.', mbError, MB_OK);",
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

function macPostinstallScript() {
  return `#!/bin/sh
set -eu
if ! /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "/Applications/Lumina.app"; then
  echo "Lumina could not register lumina links. Run the installer again or contact support." >&2
  exit 1
fi
`;
}

function macDistribution(settings) {
  return `<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="1"><title>Lumina</title><options customize="never" require-scripts="false"/><choices-outline><line choice="default"/></choices-outline><choice id="default" visible="false"><pkg-ref id="com.lumina.runtime"/></choice><pkg-ref id="com.lumina.runtime" version="${settings.version}" onConclusion="none">Lumina.pkg</pkg-ref></installer-gui-script>`;
}
