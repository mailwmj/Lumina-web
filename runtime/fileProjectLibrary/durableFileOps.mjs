const REQUIRED_OPERATIONS = Object.freeze([
  'flushFile',
  'atomicReplace',
  'atomicReplaceIfLeaseCurrent',
  'removeIfUnchanged',
  'syncDirectory',
]);
const TEST_DURABLE_FILE_OPS = new WeakMap();

export const NATIVE_DURABLE_FILE_OPS_CONFORMANCE = 'lumina-native-durable-file-ops-v1';

export function createTestDurableFileOps(operations) {
  const wrapper = Object.freeze({});
  TEST_DURABLE_FILE_OPS.set(wrapper, operations);
  return wrapper;
}

export function selectDurableFileOps(options = {}) {
  if (options.testDurableFileOps !== undefined) {
    return assertCompleteDurableFileOps(TEST_DURABLE_FILE_OPS.get(options.testDurableFileOps));
  }

  // A caller-supplied object cannot establish native durability conformance.
  // Until the runtime ships a trusted platform helper, writable roots fail closed.
  return null;
}

function assertCompleteDurableFileOps(operations) {
  if (!operations || REQUIRED_OPERATIONS.some((operation) => typeof operations[operation] !== 'function')) {
    return null;
  }
  return operations;
}
