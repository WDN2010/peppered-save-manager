import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { parseSaveBytes } from './es3';
import type { ImportReport, Settings, SnapshotFile, SnapshotMeta } from '../shared/types';

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 1_000;
const MAX_SAVE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_SAVE_BYTES = 48 * 1024 * 1024;
const MAX_META_BYTES = 256 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;

export interface ArchiveCatalog {
  listSnapshots(): Promise<SnapshotMeta[]>;
  getSnapshot(id: string): Promise<SnapshotFile>;
  getSettings(): Promise<Settings>;
  addImportedSnapshot(snapshot: SnapshotFile): Promise<void>;
}

export interface ArchiveManifestEntry {
  id: string;
  savePath: string;
  metaPath: string;
  sha256: string;
  bytes: number;
}

export interface ArchiveManifest {
  format: 'peppered-saves';
  version: 1;
  createdAt: string;
  settingsPath: 'settings.json';
  snapshots: ArchiveManifestEntry[];
}

export class ImportRejectedError extends Error {
  readonly report: ImportReport;

  constructor(message: string) {
    super(message);
    this.name = 'ImportRejectedError';
    this.report = { ok: false, added: 0, skipped: 0, rejected: 1, errors: [message] };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertSafeArchivePath(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !value || value.includes('\\') || path.posix.isAbsolute(value) || value.split('/').includes('..')) {
    throw new ImportRejectedError(`Unsafe archive path in ${field}`);
  }
}

function validateMeta(meta: unknown, id: string): asserts meta is SnapshotMeta {
  if (!isRecord(meta) || meta.version !== 1 || meta.id !== id || !UUID.test(id)) {
    throw new ImportRejectedError('Snapshot metadata has an unsupported schema');
  }
  if (typeof meta.title !== 'string' || meta.title.trim().length === 0 || meta.title.length > 160) {
    throw new ImportRejectedError('Snapshot metadata has an invalid title');
  }
  if (typeof meta.capturedAt !== 'string' || Number.isNaN(Date.parse(meta.capturedAt))) {
    throw new ImportRejectedError('Snapshot metadata has an invalid capture time');
  }
  const summary = meta.summary;
  const description = isRecord(summary) ? summary.description : null;
  if (typeof meta.sourcePath !== 'string' || meta.sourcePath.length > 4_000 || typeof meta.sha256 !== 'string' || !SHA256.test(meta.sha256) || typeof meta.bytes !== 'number' || !Number.isSafeInteger(meta.bytes) || meta.bytes < 1 || !isRecord(summary) || !isRecord(description) || typeof description.en !== 'string' || typeof description.ru !== 'string') {
    throw new ImportRejectedError('Snapshot metadata has invalid fields');
  }
}

function validateManifest(manifest: unknown): asserts manifest is ArchiveManifest {
  if (!isRecord(manifest) || manifest.format !== 'peppered-saves' || manifest.version !== 1 || !Array.isArray(manifest.snapshots) || manifest.snapshots.length > MAX_ENTRIES) {
    throw new ImportRejectedError('Unsupported catalog archive manifest');
  }
  if (typeof manifest.createdAt !== 'string' || Number.isNaN(Date.parse(manifest.createdAt))) {
    throw new ImportRejectedError('Catalog archive has an invalid creation time');
  }
  if (manifest.settingsPath !== 'settings.json') throw new ImportRejectedError('Catalog archive has an invalid settings path');
  const ids = new Set<string>();
  for (const [index, entry] of manifest.snapshots.entries()) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || ids.has(entry.id) || !UUID.test(entry.id)) {
      throw new ImportRejectedError(`Invalid or duplicate snapshot id at manifest entry ${index + 1}`);
    }
    ids.add(entry.id);
    assertSafeArchivePath(entry.savePath, `snapshots[${index}].savePath`);
    assertSafeArchivePath(entry.metaPath, `snapshots[${index}].metaPath`);
    if (typeof entry.sha256 !== 'string' || !SHA256.test(entry.sha256) || typeof entry.bytes !== 'number' || !Number.isSafeInteger(entry.bytes) || entry.bytes < 1 || entry.bytes > MAX_SAVE_BYTES) {
      throw new ImportRejectedError(`Invalid size or hash at manifest entry ${index + 1}`);
    }
    if (entry.savePath !== `snapshots/${entry.id}/save.es3` || entry.metaPath !== `snapshots/${entry.id}/meta.json`) {
      throw new ImportRejectedError(`Unexpected snapshot paths at manifest entry ${index + 1}`);
    }
  }
}

async function readZipEntry(zip: JSZip, name: string, maxBytes: number): Promise<Buffer> {
  const entry = zip.file(name);
  if (!entry || entry.dir) throw new ImportRejectedError(`Archive is missing ${name}`);
  const uncompressedSize = (entry as JSZip.JSZipObject & { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
  if (typeof uncompressedSize === 'number' && uncompressedSize > maxBytes) throw new ImportRejectedError(`Archive entry ${name} exceeds the safety limit`);
  const bytes = await entry.async('nodebuffer');
  if (bytes.length > maxBytes) throw new ImportRejectedError(`Archive entry ${name} exceeds the safety limit`);
  return bytes;
}

export async function exportCatalog(catalog: ArchiveCatalog, outputPath: string): Promise<{ snapshotCount: number; bytes: number }> {
  const snapshots = await catalog.listSnapshots();
  const settings = await catalog.getSettings();
  const zip = new JSZip();
  const manifest: ArchiveManifest = {
    format: 'peppered-saves',
    version: 1,
    createdAt: new Date().toISOString(),
    settingsPath: 'settings.json',
    snapshots: [],
  };
  zip.file('settings.json', JSON.stringify({ version: 1, language: settings.language, scale: settings.scale }, null, 2));
  for (const meta of snapshots) {
    const snapshot = await catalog.getSnapshot(meta.id);
    const savePath = `snapshots/${meta.id}/save.es3`;
    const metaPath = `snapshots/${meta.id}/meta.json`;
    manifest.snapshots.push({ id: meta.id, savePath, metaPath, sha256: meta.sha256, bytes: snapshot.bytes.length });
    zip.file(savePath, snapshot.bytes);
    zip.file(metaPath, JSON.stringify(meta, null, 2));
  }
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  const archive = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  if (archive.length > MAX_ARCHIVE_BYTES) throw new Error('Catalog export exceeds the safety limit');
  await writeFile(outputPath, archive);
  return { snapshotCount: snapshots.length, bytes: archive.length };
}

export async function importCatalog(catalog: ArchiveCatalog, archivePath: string): Promise<ImportReport> {
  const archive = await readFile(archivePath);
  if (archive.length > MAX_ARCHIVE_BYTES) throw new ImportRejectedError('Catalog archive exceeds the safety limit');
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(archive, { checkCRC32: true, createFolders: false });
  } catch {
    throw new ImportRejectedError('Catalog archive is not a readable ZIP archive');
  }
  const entries = Object.values(zip.files);
  if (entries.length > MAX_ENTRIES * 3 + 3) throw new ImportRejectedError('Catalog archive has too many entries');
  for (const [name, entry] of Object.entries(zip.files)) {
    const originalName = (entry as JSZip.JSZipObject & { unsafeOriginalName?: string }).unsafeOriginalName ?? name;
    assertSafeArchivePath(originalName, 'archive entry');
    if (entry.dir && (name === 'snapshots/' || /^snapshots\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/$/i.test(name))) continue;
    if (name !== 'manifest.json' && name !== 'settings.json' && !/^snapshots\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/(save\.es3|meta\.json)$/i.test(name)) {
      throw new ImportRejectedError(`Unexpected archive entry ${name}`);
    }
  }
  const manifestBytes = await readZipEntry(zip, 'manifest.json', MAX_META_BYTES);
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    throw new ImportRejectedError('Catalog manifest is not valid JSON');
  }
  validateManifest(manifest);
  const settingsBytes = await readZipEntry(zip, manifest.settingsPath, MAX_META_BYTES);
  try {
    const settings = JSON.parse(settingsBytes.toString('utf8')) as unknown;
    if (!isRecord(settings) || settings.version !== 1 || (settings.language !== 'en' && settings.language !== 'ru') || (settings.scale !== 100 && settings.scale !== 115 && settings.scale !== 130)) throw new Error();
  } catch {
    throw new ImportRejectedError('Catalog archive settings are invalid');
  }
  const existing = await catalog.listSnapshots();
  const existingById = new Map(existing.map((snapshot) => [snapshot.id, snapshot]));
  const existingByHash = new Set(existing.map((snapshot) => snapshot.sha256.toLowerCase()));
  const report: ImportReport = { ok: true, added: 0, skipped: 0, rejected: 0, errors: [] };
  const staged: SnapshotFile[] = [];
  let totalSaveBytes = 0;
  const stagedIds = new Set<string>();
  const stagedHashes = new Set<string>();

  for (const entry of manifest.snapshots) {
    try {
      const saveBytes = await readZipEntry(zip, entry.savePath, MAX_SAVE_BYTES);
      const metaBytes = await readZipEntry(zip, entry.metaPath, MAX_META_BYTES);
      totalSaveBytes += saveBytes.length;
      if (totalSaveBytes > MAX_TOTAL_SAVE_BYTES) throw new ImportRejectedError('Catalog archive total save size exceeds the safety limit');
      const actualHash = createHash('sha256').update(saveBytes).digest('hex');
      if (saveBytes.length !== entry.bytes || actualHash !== entry.sha256.toLowerCase()) throw new ImportRejectedError(`Snapshot ${entry.id} failed manifest hash validation`);
      let meta: unknown;
      try {
        meta = JSON.parse(metaBytes.toString('utf8'));
      } catch {
        throw new ImportRejectedError(`Snapshot ${entry.id} metadata is not valid JSON`);
      }
      validateMeta(meta, entry.id);
      if (meta.sha256.toLowerCase() !== actualHash || meta.bytes !== saveBytes.length) throw new ImportRejectedError(`Snapshot ${entry.id} failed metadata hash validation`);
      parseSaveBytes(saveBytes);
      if (existingById.has(entry.id) || stagedIds.has(entry.id)) {
        const known = existingById.get(entry.id);
        if (known?.sha256.toLowerCase() === actualHash) report.skipped += 1;
        else {
          report.rejected += 1;
          report.errors.push(`Duplicate snapshot id ${entry.id}`);
        }
        continue;
      }
      if (existingByHash.has(actualHash) || stagedHashes.has(actualHash)) {
        report.skipped += 1;
        continue;
      }
      staged.push({ meta, bytes: saveBytes });
      stagedIds.add(entry.id);
      stagedHashes.add(actualHash);
    } catch (error) {
      report.rejected += 1;
      report.errors.push(error instanceof Error ? error.message : `Snapshot ${entry.id} was rejected`);
    }
  }

  for (const snapshot of staged) {
    await catalog.addImportedSnapshot(snapshot);
    report.added += 1;
  }
  return report;
}
