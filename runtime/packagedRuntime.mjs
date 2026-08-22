export async function isPackagedRuntime() {
  try {
    const sea = await import('node:sea');
    return sea.isSea();
  } catch {
    return false;
  }
}
