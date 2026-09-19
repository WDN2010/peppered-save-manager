import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { MAX_SAVE_BYTES, MAX_TOTAL_SAVE_BYTES } from '../src/core/archive';
import { CatalogRepository } from '../src/core/catalog';

const fixturePath = path.resolve('tests/fixtures/sample-save.es3');
const fixtureBPath = path.resolve('tests/fixtures/sample-save-b.es3');

async function makeCatalog(prefix: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), `peppered-${prefix}-`));
  return { root, catalog: new CatalogRepository(root) };
}

describe('catalog export and import', () => {
  it('round trips exact save bytes, metadata, and display settings through a merge archive', async () => {
    const source = await makeCatalog('source');
    const destination = await makeCatalog('destination');
    await source.catalog.updateSettings({ language: 'ru', scale: 130 });
    const captured = await source.catalog.capture({ sourcePath: fixturePath, title: 'Round trip' });
    expect(captured.kind).toBe('created');
    if (captured.kind !== 'created') return;
    const archivePath = path.join(source.root, 'catalog.peppered-saves');
    await source.catalog.exportCatalog(archivePath);
    const report = await destination.catalog.importCatalog(archivePath);
    expect(report).toMatchObject({ ok: true, added: 1, skipped: 0, rejected: 0 });
    expect(await destination.catalog.getSettings()).toMatchObject({ language: 'ru', scale: 130, savePath: null });
    const imported = (await destination.catalog.listSnapshots())[0];
    expect(imported.title).toBe('Round trip');
    expect(imported.kind).toBe('manual');
    expect(await readFile(path.join(destination.root, 'snapshots', imported.id, 'save.es3'))).toEqual(await readFile(fixturePath));

    const again = await destination.catalog.importCatalog(archivePath);
    expect(again).toMatchObject({ ok: true, added: 0, skipped: 1, rejected: 0 });
  });

  it('rejects path traversal and leaves the existing catalog untouched', async () => {
    const destination = await makeCatalog('malicious');
    const before = await destination.catalog.capture({ sourcePath: fixtureBPath, title: 'Existing' });
    expect(before.kind).toBe('created');
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify({
      format: 'peppered-saves', version: 1, createdAt: new Date().toISOString(), settingsPath: 'settings.json',
      snapshots: [{ id: '11111111-1111-4111-8111-111111111111', savePath: '../escape.es3', metaPath: 'snapshots/x/meta.json', sha256: '0'.repeat(64), bytes: 1 }],
    }));
    zip.file('settings.json', JSON.stringify({ version: 1, language: 'en', scale: 100 }));
    zip.file('../escape.es3', 'x');
    const archivePath = path.join(destination.root, 'bad.peppered-saves');
    await writeFile(archivePath, await zip.generateAsync({ type: 'nodebuffer' }));
    await expect(destination.catalog.importCatalog(archivePath)).rejects.toThrow(/unsafe|traversal|path/i);
    expect(await destination.catalog.listSnapshots()).toHaveLength(1);
  });

  it('validates every entry before mutation and imports no valid sibling beside an invalid one', async () => {
    const source = await makeCatalog('mixed-source');
    const destination = await makeCatalog('mixed-destination');
    const first = await source.catalog.capture({ sourcePath: fixturePath, title: 'Valid sibling' });
    const second = await source.catalog.capture({ sourcePath: fixtureBPath, title: 'Invalid sibling' });
    expect(first.kind).toBe('created');
    expect(second.kind).toBe('created');
    const archivePath = path.join(source.root, 'mixed.peppered-saves');
    await source.catalog.exportCatalog(archivePath);
    const zip = await JSZip.loadAsync(await readFile(archivePath));
    const secondMeta = (await zip.file(`snapshots/${second.kind === 'created' ? second.snapshot.id : ''}/meta.json`)!.async('string'));
    const invalid = JSON.parse(secondMeta) as Record<string, unknown>;
    invalid.summary = { description: { en: 'bad', ru: 'bad' } };
    zip.file(`snapshots/${second.kind === 'created' ? second.snapshot.id : ''}/meta.json`, JSON.stringify(invalid));
    await writeFile(archivePath, await zip.generateAsync({ type: 'nodebuffer' }));
    const report = await destination.catalog.importCatalog(archivePath);
    expect(report).toMatchObject({ ok: false, added: 0, rejected: 1 });
    expect(await destination.catalog.listSnapshots()).toHaveLength(0);
  });

  it('canonicalizes uppercase UUID and SHA-256 values', async () => {
    const source = await makeCatalog('uppercase-source');
    const destination = await makeCatalog('uppercase-destination');
    const captured = await source.catalog.capture({ sourcePath: fixturePath, title: 'Uppercase archive' });
    expect(captured.kind).toBe('created');
    if (captured.kind !== 'created') return;
    const archivePath = path.join(source.root, 'uppercase.peppered-saves');
    await source.catalog.exportCatalog(archivePath);
    const zip = await JSZip.loadAsync(await readFile(archivePath));
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string')) as { snapshots: Array<{ id: string; sha256: string }> };
    manifest.snapshots[0].id = manifest.snapshots[0].id.toUpperCase();
    manifest.snapshots[0].sha256 = manifest.snapshots[0].sha256.toUpperCase();
    zip.file('manifest.json', JSON.stringify(manifest));
    await writeFile(archivePath, await zip.generateAsync({ type: 'nodebuffer' }));
    const report = await destination.catalog.importCatalog(archivePath);
    expect(report).toMatchObject({ ok: true, added: 1, rejected: 0 });
    const imported = (await destination.catalog.listSnapshots())[0];
    expect(imported.id).toBe(imported.id.toLowerCase());
    expect(imported.sha256).toBe(imported.sha256.toLowerCase());
  });

  it('rejects every unreferenced non-directory ZIP entry', async () => {
    const destination = await makeCatalog('unreferenced');
    const zip = new JSZip();
    zip.file('settings.json', JSON.stringify({ version: 1, language: 'en', scale: 100 }));
    zip.file('manifest.json', JSON.stringify({
      format: 'peppered-saves', version: 1, createdAt: new Date().toISOString(), settingsPath: 'settings.json', snapshots: [],
    }));
    zip.file('snapshots/11111111-1111-4111-8111-111111111111/save.es3', await readFile(fixturePath));
    const archivePath = path.join(destination.root, 'unreferenced.peppered-saves');
    await writeFile(archivePath, await zip.generateAsync({ type: 'nodebuffer' }));
    await expect(destination.catalog.importCatalog(archivePath)).rejects.toThrow(/unreferenced|missing files/i);
    expect(await destination.catalog.listSnapshots()).toEqual([]);
  });

  it('pre-sums manifest save bytes before decompression and rejects zip-bomb declarations', async () => {
    const destination = await makeCatalog('bomb');
    const zip = new JSZip();
    const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444'];
    const sizes = [MAX_SAVE_BYTES, MAX_SAVE_BYTES, MAX_SAVE_BYTES, 1];
    zip.file('settings.json', JSON.stringify({ version: 1, language: 'en', scale: 100 }));
    zip.file('manifest.json', JSON.stringify({
      format: 'peppered-saves', version: 1, createdAt: new Date().toISOString(), settingsPath: 'settings.json',
      snapshots: ids.map((id, index) => ({ id, savePath: `snapshots/${id}/save.es3`, metaPath: `snapshots/${id}/meta.json`, sha256: '0'.repeat(64), bytes: sizes[index] })),
    }));
    const archivePath = path.join(destination.root, 'bomb.peppered-saves');
    await writeFile(archivePath, await zip.generateAsync({ type: 'nodebuffer' }));
    await expect(destination.catalog.importCatalog(archivePath)).rejects.toThrow(/total save size/i);
    expect(MAX_TOTAL_SAVE_BYTES).toBe(48 * 1024 * 1024);
    expect(await destination.catalog.listSnapshots()).toHaveLength(0);
  });
});
