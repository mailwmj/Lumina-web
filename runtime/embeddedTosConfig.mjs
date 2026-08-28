/* global __LUMINA_EMBEDDED_TOS_ACCESS_KEY__, __LUMINA_EMBEDDED_TOS_SECRET_KEY__ */

const EMBEDDED_TOS_BUCKET = 'luminanative';
const EMBEDDED_TOS_REGION = 'cn-beijing';
const EMBEDDED_TOS_ENDPOINT = 'https://tos-cn-beijing.volces.com';

const embeddedAccessKey = typeof __LUMINA_EMBEDDED_TOS_ACCESS_KEY__ === 'string'
  ? __LUMINA_EMBEDDED_TOS_ACCESS_KEY__
  : '';
const embeddedSecretKey = typeof __LUMINA_EMBEDDED_TOS_SECRET_KEY__ === 'string'
  ? __LUMINA_EMBEDDED_TOS_SECRET_KEY__
  : '';

export function getEmbeddedTosEnvironment() {
  if (!embeddedAccessKey || !embeddedSecretKey) return {};
  return {
    LUMINA_TOS_BUCKET: EMBEDDED_TOS_BUCKET,
    LUMINA_TOS_REGION: EMBEDDED_TOS_REGION,
    LUMINA_TOS_ENDPOINT: EMBEDDED_TOS_ENDPOINT,
    LUMINA_TOS_ACCESS_KEY: embeddedAccessKey,
    LUMINA_TOS_SECRET_KEY: embeddedSecretKey,
  };
}
