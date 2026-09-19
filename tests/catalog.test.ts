import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CatalogRepository } from '../src/core/catalog';

const fixturePath = path.resolve('tests/fixtures/sample-save.es3');
const fixtureBPath = path.resolve('tests/fixtures/sample-save-b.es3');

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

    const second = await catalog.capture({ sourcePath: source, title: 'Same bytes' });
    expect(second.kind).toBe('duplicate');
    expect(second.snapshot.id).toBe(first.snapshot.id);
    expect((await catalog.listSnapshots())).toHaveLength(1);
  });

  it('renames and deletes a snapshot by validated id', async () => {
    const { catalog } = await makeCatalog();
    const first = await catalog.capture({ sourcePath: fixturePath, title: 'Before' });
    expect(first.kind).toBe('created');
    if (first.kind !== 'created') return;
    const renamed = await catalog.rename(first.snapshot.id, 'After');
    expect(renamed.title).toBe('After');
    await catalog.delete(first.snapshot.id);
    expect(await catalog.listSnapshots()).toEqual([]);
    await expect(catalog.delete('../outside')).rejects.toThrow('snapshot id');
  });

  it('creates an automatic safety snapshot and atomically restores selected bytes', async () => {
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
    expect(safety.meta.title).toMatch(/Recovery/);
  });

  it('refuses invalid targets and detects tampered snapshots before replacing anything', async () => {
    const { root, catalog } = await makeCatalog();
    const target = path.join(root, 'Save.es3');
    await writeFile(target, await readFile(fixtureBPath));
    const captured = await catalog.capture({ sourcePath: fixturePath, title: 'A checkpoint' });
    expect(captured.kind).toBe('created');
    if (captured.kind !== 'created') return;
    await expect(catalog.restore(captured.snapshot.id, path.join(root, 'not-save.json'))).rejects.toThrow('Save.es3');
    await writeFile(path.join(root, 'snapshots', captured.snapshot.id, 'save.es3'), Buffer.from('tampered'));
    await expect(catalog.restore(captured.snapshot.id, target)).rejects.toThrow('hash');
    expect(await readFile(target)).toEqual(await readFile(fixtureBPath));
    await expect(stat(path.join(root, 'snapshots', captured.snapshot.id, 'meta.json'))).resolves.toBeDefined();
  });
});
