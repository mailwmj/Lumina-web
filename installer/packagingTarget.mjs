const supportedPlatforms = new Set(['win32', 'darwin']);
const supportedArchitectures = new Set(['x64', 'arm64']);
const releaseRequirements = new Map([
  ['win32', ['ISCC.exe', 'signtool.exe']],
  ['darwin', ['codesign', 'pkgbuild', 'productbuild', 'xcrun notarytool']],
]);

export function assertSupportedPackagingTarget(platform, arch, subject) {
  if (!supportedPlatforms.has(platform)) {
    throw new Error(`Lumina ${subject} supports only Windows and macOS.`);
  }
  if (!supportedArchitectures.has(arch)) {
    throw new Error(`Lumina ${subject} supports x64 and arm64.`);
  }
}

export function releaseRequirementsFor(platform) {
  return [...releaseRequirements.get(platform)];
}
