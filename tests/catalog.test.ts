import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rename, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { replaceAtomically } from '../src/core/atomic';
import { CatalogRepository } from '../src/core/catalog';
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

describe('catalog capture and restore safety', () => {
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

  it('creates a distinct recovery snapshot even when ordinary bytes already exist', async () => {
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
    const safety = await catalog.getSnapshot(result.safetySnapshotId!);
    expect(safety.meta.kind).toBe('recovery');
    expect(safety.meta.title).toBe('Recovery copy');
    const renamed = await catalog.rename(safety.meta.id, 'Named recovery');
    expect(renamed.kind).toBe('manual');
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
    expect(result.safetySnapshotId).toBeTruthy();
    expect(await readFile(target)).toEqual(await readFile(fixturePath));
    const safety = await catalog.getSnapshot(result.safetySnapshotId!);
    expect(safety.meta.kind).toBe('recovery');
    const noNewRecovery = await catalog.restore(captured.snapshot.id, target);
    expect(noNewRecovery.safetySnapshotId).toBeNull();
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

  it('rejects symlink targets and symlink parents before replacement', async () => {
    const { root, catalog } = await makeCatalog();
    const realDirectory = path.join(root, 'real');
    const linkDirectory = path.join(root, 'link');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(realDirectory));
    const realTarget = path.join(realDirectory, 'Save.es3');
    await writeFile(realTarget, await readFile(fixtureBPath));
    await symlink(realDirectory, linkDirectory, 'junction');
    await expect(catalog.restore('11111111-1111-4111-8111-111111111111', path.join(linkDirectory, 'Save.es3'))).rejects.toThrow(/symlink|real directory/i);

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
