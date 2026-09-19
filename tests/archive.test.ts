import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { CatalogRepository } from '../src/core/catalog';

const fixturePath = path.resolve('tests/fixtures/sample-save.es3');
const fixtureBPath = path.resolve('tests/fixtures/sample-save-b.es3');

async function makeCatalog(prefix: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), `peppered-${prefix}-`));
  return { root, catalog: new CatalogRepository(root) };
}

describe('catalog export and import', () => {
  it('round trips exact save bytes and metadata through a merge archive', async () => {
    const source = await makeCatalog('source');
    const destination = await makeCatalog('destination');
    const captured = await source.catalog.capture({ sourcePath: fixturePath, title: 'Round trip' });
    expect(captured.kind).toBe('created');
    if (captured.kind !== 'created') return;
    const archivePath = path.join(source.root, 'catalog.peppered-saves');
    await source.catalog.exportCatalog(archivePath);
    const report = await destination.catalog.importCatalog(archivePath);
    expect(report).toMatchObject({ added: 1, skipped: 0, rejected: 0 });
    const imported = (await destination.catalog.listSnapshots())[0];
    expect(imported.title).toBe('Round trip');
    expect(await readFile(path.join(destination.root, 'snapshots', imported.id, 'save.es3'))).toEqual(await readFile(fixturePath));

    const again = await destination.catalog.importCatalog(archivePath);
    expect(again).toMatchObject({ added: 0, skipped: 1, rejected: 0 });
  });

  it('rejects path traversal and leaves the existing catalog untouched', async () => {
    const destination = await makeCatalog('malicious');
    const before = await destination.catalog.capture({ sourcePath: fixtureBPath, title: 'Existing' });
    expect(before.kind).toBe('created');
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify({
      format: 'peppered-saves', version: 1, createdAt: new Date().toISOString(),
      snapshots: [{ id: '11111111-1111-4111-8111-111111111111', savePath: '../escape.es3', metaPath: 'snapshots/x/meta.json', sha256: '0'.repeat(64), bytes: 1 }],
    }));
    zip.file('../escape.es3', 'x');
    const archivePath = path.join(destination.root, 'bad.peppered-saves');
    await writeFile(archivePath, await zip.generateAsync({ type: 'nodebuffer' }));
    await expect(destination.catalog.importCatalog(archivePath)).rejects.toThrow(/unsafe|traversal|path/i);
    expect(await destination.catalog.listSnapshots()).toHaveLength(1);
  });

  it('rejects hash mismatches without partially importing the archive', async () => {
    const source = await makeCatalog('hash-source');
    const destination = await makeCatalog('hash-destination');
    const captured = await source.catalog.capture({ sourcePath: fixturePath, title: 'Bad hash' });
    expect(captured.kind).toBe('created');
    if (captured.kind !== 'created') return;
    const archivePath = path.join(source.root, 'catalog.peppered-saves');
    await source.catalog.exportCatalog(archivePath);
    const zip = await JSZip.loadAsync(await readFile(archivePath));
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string')) as { snapshots: Array<{ sha256: string }> };
    manifest.snapshots[0].sha256 = 'f'.repeat(64);
    zip.file('manifest.json', JSON.stringify(manifest));
    await writeFile(archivePath, await zip.generateAsync({ type: 'nodebuffer' }));
    const report = await destination.catalog.importCatalog(archivePath);
    expect(report).toMatchObject({ added: 0, skipped: 0, rejected: 1 });
    expect(await destination.catalog.listSnapshots()).toHaveLength(0);
  });
});
