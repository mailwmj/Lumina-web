export function parseBridgeProtocol(value, errorMessage) {
  const protocol = value;
  if (
    !protocol
    || typeof protocol !== 'object'
    || Array.isArray(protocol)
    || !Number.isInteger(protocol.major)
    || protocol.major < 0
    || !Number.isInteger(protocol.minor)
    || protocol.minor < 0
    || typeof protocol.build !== 'string'
    || !protocol.build.trim()
  ) {
    throw new Error(errorMessage);
  }
  return {
    major: protocol.major,
    minor: protocol.minor,
    build: protocol.build,
  };
}

export function areBridgeProtocolsCompatible(active, expected) {
  return active.major === expected.major && active.build === expected.build;
}
