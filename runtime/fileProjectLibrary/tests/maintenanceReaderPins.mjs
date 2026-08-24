import { assert, assetLifecycleOptions, canonicalize, createAssetOwner, createFileProjectLibrary, createRawFileProjectLibrary, emptyTrashOptions, fs, os, path, projectMutationOptions, projectRecord, sha256, test, TEST_DURABLE_FILE_OPS, THIRTY_DAYS_MS, validateLibraryKey, writeOwnedAsset } from './testSupport.mjs';

test('keeps an in-flight reader catalog reachable through later cleanup', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-reader-pin-'));
  let clockNow = Date.now();
  let releaseRead;
  let reading = null;
  try {
    const reader = createFileProjectLibrary({ root });
    const writer = createFileProjectLibrary({ root });
    const cleaner = createFileProjectLibrary({ root, clock: () => clockNow });
    await Promise.all([reader.open(), writer.open(), cleaner.open()]);
    await writer.saveSnapshot(
      projectRecord('project-reader-pin', 'First', 'r1'),
      await projectMutationOptions(writer, 'absent'),
    );
    const initialHead = JSON.parse(await fs.readFile(path.join(root, 'head.json'), 'utf8'));
    const initialCommit = JSON.parse(await fs.readFile(
      path.join(root, 'commits', `${initialHead.commitId}.json`),
      'utf8',
    ));
    const initialProjectPath = path.join(
      root,
      initialCommit.projects[0].manifestPath.replace(/manifest\.json$/u, 'project.json'),
    );

    const originalOpen = fs.open;
    let blockProjectRead = true;
    let initialProjectOpens = 0;
    let signalReadStarted;
    const readStarted = new Promise((resolve) => { signalReadStarted = resolve; });
    const readMayContinue = new Promise((resolve) => { releaseRead = resolve; });
    fs.open = async (target, ...arguments_) => {
      if (path.resolve(target) === path.resolve(initialProjectPath) && arguments_[0] === 'r') {
        initialProjectOpens += 1;
      }
      if (blockProjectRead && initialProjectOpens === 2) {
        blockProjectRead = false;
        signalReadStarted();
        await readMayContinue;
      }
      return originalOpen(target, ...arguments_);
    };
    try {
      reading = reader.openProject('project-reader-pin');
      await readStarted;
      await writer.rename('project-reader-pin', 'Second', 3, await projectMutationOptions(writer, 'r1'));
      await writer.rename('project-reader-pin', 'Third', 4, await projectMutationOptions(writer, 'r2'));
      await cleaner.cleanupOrphans();
      assert.equal(await fs.stat(initialProjectPath).then(() => true).catch(() => false), true);

      releaseRead();
      assert.equal((await reading).name, 'First');
    } finally {
      releaseRead?.();
      await reading?.catch(() => {});
      fs.open = originalOpen;
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test('holds new reader pins outside garbage-collection authorization', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-reader-gate-'));
  let clockNow = Date.now();
  let releaseAuthorization;
  let signalAuthorization;
  const authorizationReached = new Promise((resolve) => { signalAuthorization = resolve; });
  try {
    const cleaner = createFileProjectLibrary({
      root,
      clock: () => clockNow,
      faultInjector: async (phase) => {
        if (phase === 'before-cleanup-authorize') {
          signalAuthorization();
          await new Promise((resolve) => { releaseAuthorization = resolve; });
        }
      },
    });
    const reader = createFileProjectLibrary({ root });
    await Promise.all([cleaner.open(), reader.open()]);
    const orphan = path.join(root, 'assets', 'a_cccccccccccccccccccccccccccccccc', 'orphan.bin');
    await fs.mkdir(path.dirname(orphan), { recursive: true });
    await fs.writeFile(orphan, Uint8Array.from([1, 2, 3]));
    clockNow += 1_000;
    await fs.utimes(orphan, (clockNow - THIRTY_DAYS_MS - 1_000) / 1_000, (clockNow - THIRTY_DAYS_MS - 1_000) / 1_000);
    assert.equal((await cleaner.cleanupOrphans()).code, 'cleanup_planned');
    clockNow += THIRTY_DAYS_MS;

    const cleaning = cleaner.cleanupOrphans();
    await authorizationReached;
    let readerSettled = false;
    const reading = reader.listProjects().then((projects) => {
      readerSettled = true;
      return projects;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(readerSettled, false);

    releaseAuthorization();
    assert.equal((await cleaning).code, 'cleanup_complete');
    assert.deepEqual(await reading, []);
  } finally {
    releaseAuthorization?.();
    await fs.rm(root, { recursive: true, force: true });
  }
});
