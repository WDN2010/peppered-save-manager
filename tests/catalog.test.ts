import { createHash, randomUUID } from 'node:crypto';
import { lstat as nativeLstat, mkdir, mkdtemp, readFile, rename, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { replaceAtomically } from '../src/core/atomic';
import { CatalogRepository, retryTransientSaveRead } from '../src/core/catalog';
import type { BigIntLstat } from '../src/core/path-safety';
import type { Settings, SnapshotFile } from '../src/shared/types';

const fixturePath = path.resolve('tests/fixtures/sample-save.es3');
const fixtureBPath = path.resolve('tests/fixtures/sample-save-b.es3');

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function makeCatalog() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'peppered-catalog-'));
  return { root, catalog: new CatalogRepository(root) };
}

describe('save read retries', () => {
  it('retries a transient Windows sharing violation and then succeeds', async () => {
    let calls = 0;
    const waits: number[] = [];
    const result = await retryTransientSaveRead(async () => {
      calls += 1;
      if (calls < 3) {
        const error = new Error('resource busy or locked') as NodeJS.ErrnoException;
        error.code = 'EBUSY';
        throw error;
      }
      return 'captured';
    }, { wait: async (milliseconds) => { waits.push(milliseconds); } });
    expect(result).toBe('captured');
    expect(calls).toBe(3);
    expect(waits).toEqual([40, 80]);
  });

  it('retries an explicit sharing violation even when Windows reports EACCES', async () => {
    let calls = 0;
    const result = await retryTransientSaveRead(async () => {
      calls += 1;
      if (calls === 1) {
        const error = new Error('ERROR_SHARING_VIOLATION: the file is being used by another process') as NodeJS.ErrnoException;
        error.code = 'EACCES';
        throw error;
      }
      return 'captured';
    }, { wait: async () => undefined });
    expect(result).toBe('captured');
    expect(calls).toBe(2);
  });

  it('preserves a permission error instead of treating it as a busy lock', async () => {
    let calls = 0;
    const run = retryTransientSaveRead(async () => {
      calls += 1;
      const error = new Error('EACCES: permission denied, open Save.es3') as NodeJS.ErrnoException;
      error.code = 'EACCES';
      throw error;
    }, { attempts: 3, wait: async () => undefined });
    await expect(run).rejects.toMatchObject({ code: 'EACCES', message: expect.stringMatching(/permission denied/i) });
    expect(calls).toBe(1);
  });

  it('preserves an operation-not-permitted error without lock evidence', async () => {
    let calls = 0;
    const run = retryTransientSaveRead(async () => {
      calls += 1;
      const error = new Error('EPERM: operation not permitted') as NodeJS.ErrnoException;
      error.code = 'EPERM';
      throw error;
    }, { attempts: 3, wait: async () => undefined });
    await expect(run).rejects.toMatchObject({ code: 'EPERM', message: expect.stringMatching(/operation not permitted/i) });
    expect(calls).toBe(1);
  });

  it('retries source changes but preserves the source-change contract after exhaustion', async () => {
    let calls = 0;
    const sourceChanged = new Error('The capture source changed while it was being read') as NodeJS.ErrnoException;
    sourceChanged.code = 'EBUSY';
    const run = retryTransientSaveRead(async () => {
      calls += 1;
      throw sourceChanged;
    }, { attempts: 3, wait: async () => undefined });
    await expect(run).rejects.toBe(sourceChanged);
    expect(calls).toBe(3);
  });

  it('returns a stable user-facing busy error after bounded retries', async () => {
    let calls = 0;
    const run = retryTransientSaveRead(async () => {
      calls += 1;
      const error = new Error('resource busy or locked') as NodeJS.ErrnoException;
      error.code = 'EBUSY';
      throw error;
    }, { attempts: 3, wait: async () => undefined });
    await expect(run).rejects.toMatchObject({ code: 'EBUSY', message: expect.stringMatching(/busy or changing/i) });
    expect(calls).toBe(3);
  });
});

describe('catalog capture and restore safety', () => {
  it('does not create a snapshot after a persistent source read failure', async () => {
    const { root, catalog } = await makeCatalog();
    const source = path.join(root, 'Save.es3');
    await mkdir(source);
    await expect(catalog.capture({ sourcePath: source, title: 'Should not exist' })).rejects.toThrow(/regular file/i);
    expect(await catalog.listSnapshots()).toEqual([]);
  });
  it('captures exact bytes, stores metadata, and deduplicates content', async () => {
    const { root, catalog } = await makeCatalog();
    const source = path.join(root, 'Save.es3');
    const bytes = await readFile(fixturePath);
    await writeFile(source, bytes);

    const first = await catalog.capture({ sourcePath: source, title: 'Elevator practice', capturedAt: '2026-01-02T03:04:05.000Z' });
    expect(first.kind).toBe('created');
    if (first.kind !== 'created') return;
    expect(await readFile(path.join(root, 'snapshots', first.snapshot.id, 'save.es3'))).toEqual(bytes);
    expect(first.snapshot.title).toBe('Elevator practice');
    expect(first.snapshot.summary.description.en).toBe('Elevator area');
    expect(first.snapshot.kind).toBe('manual');

    const second = await catalog.capture({ sourcePath: source, title: 'Same bytes' });
    expect(second.kind).toBe('duplicate');
    expect(second.snapshot.id).toBe(first.snapshot.id);
    expect((await catalog.listSnapshots())).toHaveLength(1);
  });

  it('orders equal capture times by snapshot id deterministically', async () => {
    const { catalog } = await makeCatalog();
    const capturedAt = '2026-01-02T03:04:05.000Z';
    const first = await catalog.capture({ sourcePath: fixturePath, title: 'First', capturedAt });
    const second = await catalog.capture({ sourcePath: fixtureBPath, title: 'Second', capturedAt });
    expect(first.kind).toBe('created');
    expect(second.kind).toBe('created');
    if (first.kind !== 'created' || second.kind !== 'created') return;
    const expected = [first.snapshot.id, second.snapshot.id].sort((left, right) => right.localeCompare(left));
    expect((await catalog.listSnapshots()).map((snapshot) => snapshot.id)).toEqual(expected);
  });

  it('serializes concurrent same-byte captures into one created result', async () => {
    const { root, catalog } = await makeCatalog();
    const source = path.join(root, 'Save.es3');
    await writeFile(source, await readFile(fixturePath));
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => catalog.capture({ sourcePath: source, title: `Concurrent ${index}` })));
    expect(results.filter((result) => result.kind === 'created')).toHaveLength(1);
    expect(results.filter((result) => result.kind === 'duplicate')).toHaveLength(7);
    expect(await catalog.listSnapshots()).toHaveLength(1);
  });

  it('renames and deletes a snapshot by validated id', async () => {
    const { catalog } = await makeCatalog();
    const first = await catalog.capture({ sourcePath: fixturePath, title: 'Before' });
    expect(first.kind).toBe('created');
    if (first.kind !== 'created') return;
    const renamed = await catalog.rename(first.snapshot.id, 'After');
    expect(renamed.title).toBe('After');
    expect(renamed.kind).toBe('manual');
    await catalog.delete(first.snapshot.id);
    expect(await catalog.listSnapshots()).toEqual([]);
    await expect(catalog.delete('../outside')).rejects.toThrow('snapshot id');
  });

  it('creates one rolling recovery snapshot and preserves ordinary manual snapshots', async () => {
    const { root, catalog } = await makeCatalog();
    const target = path.join(root, 'Save.es3');
    await writeFile(target, await readFile(fixturePath));
    const ordinary = await catalog.capture({ sourcePath: target, title: 'Ordinary current' });
    const selected = await catalog.capture({ sourcePath: fixtureBPath, title: 'Selected' });
    expect(ordinary.kind).toBe('created');
    expect(selected.kind).toBe('created');
    if (selected.kind !== 'created') return;
    const result = await catalog.restore(selected.snapshot.id, target);
    expect(result.safetySnapshotId).toBeTruthy();
    expect(result.safetySnapshotId).not.toBe(ordinary.kind === 'created' ? ordinary.snapshot.id : null);
    expect((await catalog.listSnapshots()).filter((snapshot) => snapshot.kind === 'recovery')).toHaveLength(1);
    const safety = await catalog.getSnapshot(result.safetySnapshotId!);
    expect(safety.meta.kind).toBe('recovery');
    expect(safety.meta.title).toBe('Recovery copy');
    expect(safety.bytes).toEqual(await readFile(fixturePath));
    expect((await catalog.listSnapshots()).filter((snapshot) => snapshot.kind === 'manual')).toHaveLength(2);
    const renamed = await catalog.rename(safety.meta.id, 'Named recovery');
    expect(renamed.kind).toBe('manual');
  }, 20_000);

  it('overwrites the rolling recovery with the immediately previous live bytes', async () => {
    const { root, catalog } = await makeCatalog();
    const target = path.join(root, 'Save.es3');
    await writeFile(target, await readFile(fixturePath));
    const first = await catalog.capture({ sourcePath: fixturePath, title: 'First' });
    const second = await catalog.capture({ sourcePath: fixtureBPath, title: 'Second' });
    expect(first.kind).toBe('created');
    expect(second.kind).toBe('created');
    if (first.kind !== 'created' || second.kind !== 'created') return;

    const firstRestore = await catalog.restore(second.snapshot.id, target);
    const firstRecoveryId = firstRestore.safetySnapshotId;
    expect(firstRecoveryId).toBeTruthy();
    expect((await catalog.listSnapshots()).filter((snapshot) => snapshot.kind === 'recovery')).toHaveLength(1);

    const secondRestore = await catalog.restore(first.snapshot.id, target);
    expect(secondRestore.safetySnapshotId).toBeTruthy();
    expect(secondRestore.safetySnapshotId).not.toBe(firstRecoveryId);
    const recoveries = (await catalog.listSnapshots()).filter((snapshot) => snapshot.kind === 'recovery');
    expect(recoveries).toHaveLength(1);
    const recovery = await catalog.getSnapshot(recoveries[0].id);
    expect(recovery.bytes).toEqual(await readFile(fixtureBPath));
  }, 20_000);

  it('converges legacy multiple automatic recoveries on the next differing restore', async () => {
    const { root, catalog } = await makeCatalog();
    const target = path.join(root, 'Save.es3');
    await writeFile(target, await readFile(fixturePath));
    const selected = await catalog.capture({ sourcePath: fixtureBPath, title: 'Selected' });
    const legacyOne = await catalog.capture({ sourcePath: fixturePath, title: 'Legacy source' });
    expect(selected.kind).toBe('created');
    expect(legacyOne.kind).toBe('created');
    if (selected.kind !== 'created' || legacyOne.kind !== 'created') return;
    const legacyFile = await catalog.getSnapshot(legacyOne.snapshot.id);
    await catalog.addImportedSnapshot({
      bytes: legacyFile.bytes,
      meta: { ...legacyFile.meta, id: randomUUID(), kind: 'recovery', title: 'Recovery copy', capturedAt: '2026-01-01T00:00:00.000Z' },
    });
    await catalog.addImportedSnapshot({
      bytes: legacyFile.bytes,
      meta: { ...legacyFile.meta, id: randomUUID(), kind: 'recovery', title: 'Recovery copy', capturedAt: '2026-01-02T00:00:00.000Z' },
    });
    const before = (await catalog.listSnapshots()).filter((snapshot) => snapshot.kind === 'recovery');
    expect(before).toHaveLength(2);

    const result = await catalog.restore(selected.snapshot.id, target);
    expect(result.safetySnapshotId).toBeTruthy();
    expect(result.safetySnapshotId).not.toBe(before[0].id);
    const recoveries = (await catalog.listSnapshots()).filter((snapshot) => snapshot.kind === 'recovery');
    expect(recoveries).toHaveLength(1);
    expect((await catalog.getSnapshot(recoveries[0].id)).bytes).toEqual(await readFile(fixturePath));
    expect((await catalog.listSnapshots()).filter((snapshot) => snapshot.kind === 'manual')).toHaveLength(2);
  });

  it('keeps a renamed recovery manual and creates a new rolling recovery', async () => {
    const { root, catalog } = await makeCatalog();
    const target = path.join(root, 'Save.es3');
    await writeFile(target, await readFile(fixturePath));
    const selected = await catalog.capture({ sourcePath: fixtureBPath, title: 'Selected' });
    expect(selected.kind).toBe('created');
    if (selected.kind !== 'created') return;
    const first = await catalog.restore(selected.snapshot.id, target);
    expect(first.safetySnapshotId).toBeTruthy();
    const renamed = await catalog.rename(first.safetySnapshotId!, 'Keep this recovery');
    expect(renamed.kind).toBe('manual');

    await catalog.restore(selected.snapshot.id, target);
    const recoveries = (await catalog.listSnapshots()).filter((snapshot) => snapshot.kind === 'recovery');
    expect(recoveries).toHaveLength(0);

    const result = await catalog.restore(renamed.id, target);
    expect(result.safetySnapshotId).toBeTruthy();
    const snapshots = await catalog.listSnapshots();
    expect(snapshots.filter((snapshot) => snapshot.kind === 'recovery')).toHaveLength(1);
    expect(snapshots.filter((snapshot) => snapshot.kind === 'manual' && snapshot.id === renamed.id)).toHaveLength(1);
  });

  it('restores with an atomic replacement and does not create a recovery when bytes match', async () => {
    const { root, catalog } = await makeCatalog();
    const target = path.join(root, 'Save.es3');
    await writeFile(target, await readFile(fixtureBPath));
    const captured = await catalog.capture({ sourcePath: fixturePath, title: 'A checkpoint' });
    expect(captured.kind).toBe('created');
    if (captured.kind !== 'created') return;

    const result = await catalog.restore(captured.snapshot.id, target);
    expect(result.restored).toBe(true);
    expect(result.previousState).toBe('different');
    expect(result.safetySnapshotId).toBeTruthy();
    expect(await readFile(target)).toEqual(await readFile(fixturePath));
    const safety = await catalog.getSnapshot(result.safetySnapshotId!);
    expect(safety.meta.kind).toBe('recovery');
    const noNewRecovery = await catalog.restore(captured.snapshot.id, target);
    expect(noNewRecovery.safetySnapshotId).toBeNull();
    expect(noNewRecovery.previousState).toBe('identical');
  });

  it('does not update recovery state for an identical or absent target', async () => {
    const { root, catalog } = await makeCatalog();
    const target = path.join(root, 'Save.es3');
    await writeFile(target, await readFile(fixturePath));
    const selected = await catalog.capture({ sourcePath: fixtureBPath, title: 'Selected' });
    expect(selected.kind).toBe('created');
    if (selected.kind !== 'created') return;
    const first = await catalog.restore(selected.snapshot.id, target);
    expect(first.safetySnapshotId).toBeTruthy();
    const recoveryBefore = await catalog.getSnapshot(first.safetySnapshotId!);
    const identical = await catalog.restore(selected.snapshot.id, target);
    expect(identical).toMatchObject({ safetySnapshotId: null, previousState: 'identical' });
    expect(await catalog.getSnapshot(first.safetySnapshotId!)).toEqual(recoveryBefore);

    const absentTarget = path.join(root, 'absent', 'Save.es3');
    await mkdir(path.dirname(absentTarget), { recursive: true });
    const absent = await catalog.restore(selected.snapshot.id, absentTarget);
    expect(absent).toMatchObject({ safetySnapshotId: null, previousState: 'absent' });
    expect((await catalog.listSnapshots()).filter((snapshot) => snapshot.kind === 'recovery')).toHaveLength(1);
  });

  it('rolls back a staged rolling recovery when active replacement fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'peppered-rolling-failure-'));
    const target = path.join(root, 'Save.es3');
    await writeFile(target, await readFile(fixturePath));
    const catalog = new CatalogRepository(root);
    const first = await catalog.capture({ sourcePath: fixturePath, title: 'First' });
    const second = await catalog.capture({ sourcePath: fixtureBPath, title: 'Second' });
    expect(first.kind).toBe('created');
    expect(second.kind).toBe('created');
    if (first.kind !== 'created' || second.kind !== 'created') return;
    await catalog.restore(second.snapshot.id, target);
    const previousRecovery = (await catalog.listSnapshots()).find((snapshot) => snapshot.kind === 'recovery');
    expect(previousRecovery).toBeTruthy();
    const failing = new CatalogRepository(root, { replaceAtomically: async () => { throw new Error('injected replacement failure'); } });
    await expect(failing.restore(first.snapshot.id, target)).rejects.toThrow('injected replacement failure');
    const recoveries = (await catalog.listSnapshots()).filter((snapshot) => snapshot.kind === 'recovery');
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0].id).toBe(previousRecovery!.id);
    expect(await catalog.getSnapshot(previousRecovery!.id)).toMatchObject({ bytes: await readFile(fixturePath) });
    expect(await readFile(target)).toEqual(await readFile(fixtureBPath));
  });

  it('preserves the original replacement evidence when candidate cleanup also fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'peppered-rolling-cleanup-failure-'));
    const target = path.join(root, 'Save.es3');
    await writeFile(target, await readFile(fixturePath));
    const seed = new CatalogRepository(root);
    const first = await seed.capture({ sourcePath: fixturePath, title: 'First' });
    const second = await seed.capture({ sourcePath: fixtureBPath, title: 'Second' });
    expect(first.kind).toBe('created');
    expect(second.kind).toBe('created');
    if (first.kind !== 'created' || second.kind !== 'created') return;
    await seed.restore(second.snapshot.id, target);
    const previousRecovery = (await seed.listSnapshots()).find((snapshot) => snapshot.kind === 'recovery');
    expect(previousRecovery).toBeTruthy();

    let originalFailure: Error | undefined;
    const failing = new CatalogRepository(root, {
      replaceAtomically: async (actualTarget, bytes, options) => {
        try {
          await replaceAtomically(actualTarget, bytes, {
            ...options,
            platform: 'win32',
            retries: 0,
            windowsGuardedReplace: async () => {
              const error = new Error('sharing violation') as NodeJS.ErrnoException;
              error.code = 'EBUSY';
              throw error;
            },
          });
        } catch (error) {
          originalFailure = error as Error;
          throw error;
        }
      },
    });
    const failingRepository = failing as unknown as { removeQuarantinedRecoveryCandidate: (quarantinePath: string) => Promise<void> };
    failingRepository.removeQuarantinedRecoveryCandidate = async (quarantinePath) => {
      await unlink(path.join(quarantinePath, 'save.es3'));
      throw new Error('candidate quarantine deletion failed after partial delete');
    };

    let failure: Error | undefined;
    try { await failing.restore(first.snapshot.id, target); }
    catch (error) { failure = error as Error; }
    expect(originalFailure).toBeTruthy();
    expect(failure?.cause).toBe(originalFailure);
    expect(failure?.message).toMatch(/QUARANTINE_RESIDUE_AT .+; candidate quarantine deletion failed after partial delete;/);
    expect(failure?.message).toMatch(/Temporary recovery file preserved at .+$/);
    const quarantinePath = failure?.message.match(/QUARANTINE_RESIDUE_AT ([^\r\n;]+)/)?.[1];
    expect(quarantinePath).toBeTruthy();
    await expect(stat(path.join(quarantinePath!, 'meta.json'))).resolves.toBeDefined();
    await expect(stat(path.join(quarantinePath!, 'save.es3'))).rejects.toThrow();
    expect((await failing.listSnapshots()).filter((snapshot) => snapshot.kind === 'recovery')).toHaveLength(1);
    expect((await failing.listSnapshots()).find((snapshot) => snapshot.id === previousRecovery!.id)).toBeTruthy();
    expect(await seed.getSnapshot(previousRecovery!.id)).toMatchObject({ bytes: await readFile(fixturePath) });
    expect(await readFile(target)).toEqual(await readFile(fixtureBPath));
  });

  it('keeps a valid recovery candidate visible when quarantine rename fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'peppered-rolling-quarantine-rename-'));
    const target = path.join(root, 'Save.es3');
    await writeFile(target, await readFile(fixturePath));
    const seed = new CatalogRepository(root);
    const first = await seed.capture({ sourcePath: fixturePath, title: 'First' });
    const second = await seed.capture({ sourcePath: fixtureBPath, title: 'Second' });
    expect(first.kind).toBe('created');
    expect(second.kind).toBe('created');
    if (first.kind !== 'created' || second.kind !== 'created') return;

    const failing = new CatalogRepository(root, { replaceAtomically: async () => { throw new Error('injected replacement failure'); } });
    const failingRepository = failing as unknown as { quarantineRecoveryCandidate: (id: string) => Promise<never> };
    failingRepository.quarantineRecoveryCandidate = async () => { throw new Error('quarantine rename denied'); };

    let failure: Error | undefined;
    try { await failing.restore(second.snapshot.id, target); }
    catch (error) { failure = error as Error; }
    expect(failure?.cause).toBeInstanceOf(Error);
    expect(failure?.message).toMatch(/remains valid and visible at .+CANDIDATE_PRESERVED_AT .+; quarantine rename denied;/);
    const candidatePath = failure?.message.match(/CANDIDATE_PRESERVED_AT ([^\r\n;]+)/)?.[1];
    expect(candidatePath).toBeTruthy();
    await expect(stat(path.join(candidatePath!, 'save.es3'))).resolves.toBeDefined();
    expect((await failing.listSnapshots()).filter((snapshot) => snapshot.kind === 'recovery')).toHaveLength(1);
    expect((await failing.listSnapshots()).find((snapshot) => snapshot.kind === 'recovery')?.id).toBe(path.basename(candidatePath!));
    expect(await readFile(target)).toEqual(await readFile(fixturePath));
  });

  it('reports partial restore state when old recovery cleanup fails after replacement', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'peppered-rolling-post-cleanup-'));
    const target = path.join(root, 'Save.es3');
    await writeFile(target, await readFile(fixturePath));
    const seed = new CatalogRepository(root);
    const original = await seed.capture({ sourcePath: fixturePath, title: 'Original' });
    const selected = await seed.capture({ sourcePath: fixtureBPath, title: 'Selected' });
    expect(original.kind).toBe('created');
    expect(selected.kind).toBe('created');
    if (original.kind !== 'created' || selected.kind !== 'created') return;
    const first = await seed.restore(selected.snapshot.id, target);
    expect(first.safetySnapshotId).toBeTruthy();

    const failing = new CatalogRepository(root);
    const failingRepository = failing as unknown as { removeSnapshotDirectory: (id: string, force: boolean) => Promise<void> };
    const originalRemove = failingRepository.removeSnapshotDirectory.bind(failing);
    const cleanupFailure = new Error('old recovery cleanup denied');
    failingRepository.removeSnapshotDirectory = async (id, force) => {
      if (!force) throw cleanupFailure;
      return originalRemove(id, force);
    };

    let failure: Error | undefined;
    try { await failing.restore(original.snapshot.id, target); }
    catch (error) { failure = error as Error; }
    expect(failure?.message).toMatch(/partial|cleanup|automatic recovery/i);
    expect(failure?.cause).toBe(cleanupFailure);
    expect(await readFile(target)).toEqual(await readFile(fixturePath));
    expect((await failing.listSnapshots()).filter((snapshot) => snapshot.kind === 'recovery')).toHaveLength(2);
  });

  it('distinguishes restoring into an absent target from an identical save', async () => {
    const { root, catalog } = await makeCatalog();
    const target = path.join(root, 'Save.es3');
    const captured = await catalog.capture({ sourcePath: fixturePath, title: 'Create target' });
    expect(captured.kind).toBe('created');
    if (captured.kind !== 'created') return;
    const result = await catalog.restore(captured.snapshot.id, target);
    expect(result).toMatchObject({ restored: true, safetySnapshotId: null, previousState: 'absent' });
    expect(await readFile(target)).toEqual(await readFile(fixturePath));
  });

  it('preserves the original and reports a recovery temp when replacement fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'peppered-atomic-'));
    const target = path.join(root, 'Save.es3');
    const original = Buffer.from('original');
    await writeFile(target, original);
    const injectedRename = async () => {
      const error = new Error('sharing violation') as NodeJS.ErrnoException;
      error.code = 'EBUSY';
      throw error;
    };
    let failure: Error | undefined;
    try { await replaceAtomically(target, Buffer.from('replacement'), { rename: injectedRename, retries: 0 }); }
    catch (error) { failure = error as Error; }
    expect(failure?.message).toMatch(/Temporary recovery file preserved at/);
    expect(await readFile(target)).toEqual(original);
    const evidence = failure?.message.match(/preserved at (.+)$/)?.[1];
    expect(evidence).toBeTruthy();
    await expect(stat(evidence!)).resolves.toBeDefined();
  });

  it('rejects content changed since recovery capture before replacement', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'peppered-concurrent-'));
    const target = path.join(root, 'Save.es3');
    const original = Buffer.from('original');
    const newer = Buffer.from('newer peer write');
    const replacement = Buffer.from('selected snapshot');
    await writeFile(target, original);
    await writeFile(target, newer);
    await expect(replaceAtomically(target, replacement, {
      guardedTargetSha256: sha256(original),
      expectedReplacementSha256: sha256(replacement),
    })).rejects.toThrow(/changed while restore was being prepared/i);
    expect(await readFile(target)).toEqual(newer);
  });

  it('passes exact expected hashes to the Windows guarded replacement helper', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'peppered-win-guard-'));
    const target = path.join(root, 'Save.es3');
    const original = Buffer.from('original');
    const replacement = Buffer.from('selected snapshot');
    await writeFile(target, original);
    let called = false;
    await replaceAtomically(target, replacement, {
      platform: 'win32',
      guardedTargetSha256: sha256(original),
      expectedReplacementSha256: sha256(replacement),
      windowsGuardedReplace: async (actualTarget, temporary, expectedTarget, expectedReplacement) => {
        called = true;
        expect(actualTarget).toBe(target);
        expect(expectedTarget).toBe(sha256(original));
        expect(expectedReplacement).toBe(sha256(replacement));
        expect(await readFile(temporary)).toEqual(replacement);
        await rename(temporary, actualTarget);
      },
    });
    expect(called).toBe(true);
    expect(await readFile(target)).toEqual(replacement);
  });

  it('accepts Windows realpath aliases that identify the same parent directory', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'peppered-win-alias-'));
    const target = path.join(root, 'Save.es3');
    const replacement = Buffer.from('replacement through a benign alias');
    const parent = path.dirname(target);
    const aliasParent = path.join(root, 'BENIGN~1');
    await writeFile(target, Buffer.from('original'));
    const injectedLstat: BigIntLstat = async (value, options) => value === aliasParent
      ? nativeLstat(parent, options)
      : nativeLstat(value, options);

    await replaceAtomically(target, replacement, {
      platform: 'win32',
      lstat: injectedLstat,
      realpath: (async (value: string) => value === parent ? aliasParent : value) as typeof import('node:fs/promises').realpath,
    });

    expect(await readFile(target)).toEqual(replacement);
  });

  it('rejects colliding numeric aliases when exact BigInt identities differ', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'peppered-win-bigint-'));
    const target = path.join(root, 'Save.es3');
    const parent = path.dirname(target);
    const aliasParent = path.join(root, 'BENIGN~1');
    await writeFile(target, Buffer.from('original'));

    const first = (2n ** 54n) + 1n;
    const second = (2n ** 54n) + 2n;
    expect(first).not.toBe(second);
    expect(Number(first)).toBe(Number(second));
    const identity = (info: BigIntStats, dev: bigint, ino: bigint): BigIntStats => {
      info.dev = dev;
      info.ino = ino;
      return info;
    };
    const injectedLstat: BigIntLstat = async (value, options) => {
      if (options.bigint !== true) throw new Error('exact lstat required');
      const info = await nativeLstat(value === aliasParent ? parent : value, options);
      return value === aliasParent ? identity(info, second, second) : identity(info, first, first);
    };

    await expect(replaceAtomically(target, Buffer.from('replacement'), {
      platform: 'win32',
      lstat: injectedLstat,
      realpath: (async (value: string) => value === parent ? aliasParent : value) as typeof import('node:fs/promises').realpath,
    })).rejects.toThrow(/symlink/i);
  });

  it('reports guarded backup evidence when a Windows rollback failure consumes the temporary', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'peppered-win-rollback-'));
    const target = path.join(root, 'Save.es3');
    const original = Buffer.from('original');
    const replacement = Buffer.from('selected snapshot');
    const backup = path.join(root, 'guarded backup with spaces.bak');
    await writeFile(target, original);
    let helperCalls = 0;
    let failure: Error | undefined;
    try {
      await replaceAtomically(target, replacement, {
        platform: 'win32',
        guardedTargetSha256: sha256(original),
        expectedReplacementSha256: sha256(replacement),
        windowsGuardedReplace: async (_actualTarget, temporary) => {
          helperCalls += 1;
          await unlink(temporary);
          const error = new Error(`ROLLBACK_FAILED_WIN32_32 BACKUP_PRESERVED_AT ${backup}`) as NodeJS.ErrnoException;
          error.code = 'EBUSY';
          throw error;
        },
      });
    } catch (error) { failure = error as Error; }
    expect(helperCalls).toBe(1);
    expect(failure).toBeTruthy();
    expect(failure?.message).toContain(`BACKUP_PRESERVED_AT ${backup}`);
    expect(failure?.message).not.toContain('Temporary recovery file preserved at');
    expect(failure?.cause).toBeInstanceOf(Error);
    expect(await readFile(target)).toEqual(original);
  });

  it('rejects symlink targets and symlink parents before replacement', async () => {
    const { root, catalog } = await makeCatalog();
    const realDirectory = path.join(root, 'real');
    const linkDirectory = path.join(root, 'link');
    await mkdir(realDirectory);
    const nestedRealDirectory = path.join(realDirectory, 'nested');
    await mkdir(nestedRealDirectory);
    const realTarget = path.join(realDirectory, 'Save.es3');
    const nestedRealTarget = path.join(nestedRealDirectory, 'Save.es3');
    await writeFile(realTarget, await readFile(fixtureBPath));
    await writeFile(nestedRealTarget, await readFile(fixtureBPath));
    await symlink(realDirectory, linkDirectory, 'junction');
    await expect(catalog.restore('11111111-1111-4111-8111-111111111111', path.join(linkDirectory, 'Save.es3'))).rejects.toThrow(/symlink|real directory/i);
    await expect(catalog.capture({ sourcePath: path.join(linkDirectory, 'nested', 'Save.es3'), title: 'Nested symlink source' })).rejects.toThrow(/symlink|real directory/i);
    await expect(replaceAtomically(path.join(linkDirectory, 'nested', 'Save.es3'), Buffer.from('replacement'))).rejects.toThrow(/symlink|real directory/i);

    const target = path.join(root, 'Save.es3');
    await symlink(realTarget, target);
    await expect(replaceAtomically(target, Buffer.from('replacement'))).rejects.toThrow(/regular file|symlink/i);
    await expect(catalog.capture({ sourcePath: target, title: 'Symlink source' })).rejects.toThrow(/regular file|symlink/i);
  });

  it('skips corrupt local metadata and normalizes invalid persisted save paths', async () => {
    const { root, catalog } = await makeCatalog();
    const captured = await catalog.capture({ sourcePath: fixturePath, title: 'Corrupt me' });
    expect(captured.kind).toBe('created');
    if (captured.kind !== 'created') return;
    const metaPath = path.join(root, 'snapshots', captured.snapshot.id, 'meta.json');
    const metadata = JSON.parse(await readFile(metaPath, 'utf8')) as Record<string, unknown>;
    metadata.summary = { description: { en: 'not complete', ru: 'not complete' } };
    await writeFile(metaPath, JSON.stringify(metadata));
    expect(await catalog.listSnapshots()).toEqual([]);
    await writeFile(path.join(root, 'settings.json'), JSON.stringify({ version: 1, language: 'en', scale: 100, savePath: path.join(root, 'not-save.json') }));
    expect((await catalog.getSettings()).savePath).toBeNull();
  });

  it('serializes settings repair with concurrent user updates', async () => {
    const { root, catalog } = await makeCatalog();
    await catalog.initialize();
    await writeFile(path.join(root, 'settings.json'), JSON.stringify({ language: 'en', version: 1, savePath: null, scale: 100 }));
    const repository = catalog as unknown as { writeSettings: (settings: Settings) => Promise<void> };
    const originalWrite = repository.writeSettings.bind(catalog);
    let releaseRepair!: () => void;
    let signalRepair!: () => void;
    const repairEntered = new Promise<void>((resolve) => { signalRepair = resolve; });
    const repairReleased = new Promise<void>((resolve) => { releaseRepair = resolve; });
    let heldRepair = false;
    repository.writeSettings = async (settings) => {
      if (!heldRepair && settings.language === 'en') {
        heldRepair = true;
        signalRepair();
        await repairReleased;
      }
      await originalWrite(settings);
    };
    const repair = catalog.getSettings();
    await repairEntered;
    const update = catalog.updateSettings({ language: 'ru', scale: 130 });
    releaseRepair();
    await Promise.all([repair, update]);
    const persisted = JSON.parse(await readFile(path.join(root, 'settings.json'), 'utf8')) as Settings;
    expect(persisted).toMatchObject({ language: 'ru', scale: 130 });
  });

  it('rolls back every newly-added snapshot when a batch commit fails', async () => {
    const source = await makeCatalog();
    const destination = await makeCatalog();
    const first = await source.catalog.capture({ sourcePath: fixturePath, title: 'Batch one' });
    const second = await source.catalog.capture({ sourcePath: fixtureBPath, title: 'Batch two' });
    expect(first.kind).toBe('created');
    expect(second.kind).toBe('created');
    if (first.kind !== 'created' || second.kind !== 'created') return;
    const snapshots: SnapshotFile[] = [await source.catalog.getSnapshot(first.snapshot.id), await source.catalog.getSnapshot(second.snapshot.id)];
    const repository = destination.catalog as unknown as { createSnapshot: (snapshot: SnapshotFile) => Promise<unknown> };
    const originalCreate = repository.createSnapshot.bind(destination.catalog);
    let calls = 0;
    repository.createSnapshot = async (snapshot) => {
      calls += 1;
      if (calls === 2) throw new Error('injected commit failure');
      return originalCreate(snapshot);
    };
    await expect(destination.catalog.commitImportedSnapshots(snapshots)).rejects.toThrow('injected commit failure');
    expect(await destination.catalog.listSnapshots()).toEqual([]);
  });
});
