import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { atomicWriteFile } from './atomic';
import { parseSaveBytes } from './es3';
import { validateSnapshotMeta } from './metadata';
import { canonicalSnapshotId, canonicalSha256, isIsoDate } from './validation';
import type { ImportReport, Settings, SnapshotFile, SnapshotMeta } from '../shared/types';

export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
export const MAX_ENTRIES = 1_000;
export const MAX_SAVE_BYTES = 16 * 1024 * 1024;
export const MAX_TOTAL_SAVE_BYTES = 48 * 1024 * 1024;
export const MAX_META_BYTES = 256 * 1024;

export interface ArchiveCatalog {
  listSnapshots(): Promise<SnapshotMeta[]>;
  getSnapshot(id: string): Promise<SnapshotFile>;
  getSettings(): Promise<Settings>;
  commitImportedSnapshots(snapshots: SnapshotFile[], importedSettings?: Pick<Settings, 'language' | 'scale'>): Promise<void>;
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

export class ImportLimitError extends ImportRejectedError {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeUtf8(bytes: Buffer, label: string): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new ImportRejectedError(`${label} is not valid UTF-8`); }
}

function assertSafeArchivePath(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !value || value.includes('\\') || path.posix.isAbsolute(value) || value.split('/').includes('..')) {
    throw new ImportRejectedError(`Unsafe archive path in ${field}`);
  }
}

function validateManifest(manifest: unknown): ArchiveManifest {
  if (!isRecord(manifest) || manifest.format !== 'peppered-saves' || manifest.version !== 1 || !Array.isArray(manifest.snapshots) || manifest.snapshots.length > MAX_ENTRIES) {
    throw new ImportRejectedError('Unsupported catalog archive manifest');
  }
  if (!isIsoDate(manifest.createdAt) || manifest.settingsPath !== 'settings.json') throw new ImportRejectedError('Catalog archive manifest is invalid');
  const ids = new Set<string>();
  let totalSaveBytes = 0;
  const snapshots: ArchiveManifestEntry[] = [];
  for (const [index, rawEntry] of manifest.snapshots.entries()) {
    if (!isRecord(rawEntry)) throw new ImportRejectedError(`Invalid snapshot manifest entry ${index + 1}`);
    const id = canonicalSnapshotId(rawEntry.id);
    const sha256 = canonicalSha256(rawEntry.sha256);
    if (!id || ids.has(id)) throw new ImportRejectedError(`Invalid or duplicate snapshot id at manifest entry ${index + 1}`);
    ids.add(id);
    assertSafeArchivePath(rawEntry.savePath, `snapshots[${index}].savePath`);
    assertSafeArchivePath(rawEntry.metaPath, `snapshots[${index}].metaPath`);
    const bytes = rawEntry.bytes;
    if (!sha256 || typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_SAVE_BYTES) throw new ImportRejectedError(`Invalid size or hash at manifest entry ${index + 1}`);
    if (rawEntry.savePath.toLowerCase() !== `snapshots/${id}/save.es3` || rawEntry.metaPath.toLowerCase() !== `snapshots/${id}/meta.json`) throw new ImportRejectedError(`Unexpected snapshot paths at manifest entry ${index + 1}`);
    totalSaveBytes += bytes;
    if (totalSaveBytes > MAX_TOTAL_SAVE_BYTES) throw new ImportRejectedError('Catalog archive total save size exceeds the safety limit');
    snapshots.push({ id, savePath: rawEntry.savePath, metaPath: rawEntry.metaPath, sha256, bytes });
  }
  return { format: 'peppered-saves', version: 1, createdAt: manifest.createdAt, settingsPath: 'settings.json', snapshots };
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
    manifest.snapshots.push({ id: meta.id, savePath, metaPath, sha256: meta.sha256.toLowerCase(), bytes: snapshot.bytes.length });
    zip.file(savePath, snapshot.bytes);
    zip.file(metaPath, JSON.stringify(meta, null, 2));
  }
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  const archive = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  if (archive.length > MAX_ARCHIVE_BYTES) throw new Error('Catalog export exceeds the safety limit');
  await atomicWriteFile(outputPath, archive);
  return { snapshotCount: snapshots.length, bytes: archive.length };
}

export async function importCatalog(catalog: ArchiveCatalog, archivePath: string): Promise<ImportReport> {
  const archive = await readFile(archivePath);
  if (archive.length > MAX_ARCHIVE_BYTES) throw new ImportRejectedError('Catalog archive exceeds the safety limit');
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(archive, { checkCRC32: true, createFolders: false }); }
  catch { throw new ImportRejectedError('Catalog archive is not a readable ZIP archive'); }
  const entries = Object.values(zip.files);
  if (entries.length > MAX_ENTRIES * 3 + 3) throw new ImportRejectedError('Catalog archive has too many entries');
  for (const [name, entry] of Object.entries(zip.files)) {
    const originalName = (entry as JSZip.JSZipObject & { unsafeOriginalName?: string }).unsafeOriginalName ?? name;
    assertSafeArchivePath(originalName, 'archive entry');
    if (entry.dir && (name === 'snapshots/' || /^snapshots\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/$/i.test(name))) continue;
    if (name !== 'manifest.json' && name !== 'settings.json' && !/^snapshots\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/(save\.es3|meta\.json)$/i.test(name)) throw new ImportRejectedError(`Unexpected archive entry ${name}`);
  }
  const manifestBytes = await readZipEntry(zip, 'manifest.json', MAX_META_BYTES);
  let manifestValue: unknown;
  try { manifestValue = JSON.parse(decodeUtf8(manifestBytes, 'Catalog manifest')) as unknown; }
  catch (error) { if (error instanceof ImportRejectedError) throw error; throw new ImportRejectedError('Catalog manifest is not valid JSON'); }
  const manifest = validateManifest(manifestValue);
  const settingsBytes = await readZipEntry(zip, manifest.settingsPath, MAX_META_BYTES);
  let importedSettings: Pick<Settings, 'language' | 'scale'>;
  try {
    const settings = JSON.parse(decodeUtf8(settingsBytes, 'Catalog settings')) as unknown;
    if (!isRecord(settings) || settings.version !== 1 || (settings.language !== 'en' && settings.language !== 'ru') || (settings.scale !== 100 && settings.scale !== 115 && settings.scale !== 130)) throw new Error();
    importedSettings = { language: settings.language, scale: settings.scale };
  } catch (error) {
    if (error instanceof ImportRejectedError) throw error;
    throw new ImportRejectedError('Catalog archive settings are invalid');
  }
  const existing = await catalog.listSnapshots();
  const existingById = new Map(existing.map((snapshot) => [snapshot.id.toLowerCase(), snapshot]));
  const existingByHash = new Set(existing.map((snapshot) => snapshot.sha256.toLowerCase()));
  const staged: SnapshotFile[] = [];
  const stagedIds = new Set<string>();
  const stagedHashes = new Set<string>();
  const errors: string[] = [];
  let skipped = 0;
  let actualTotalSaveBytes = 0;

  for (const entry of manifest.snapshots) {
    try {
      const saveBytes = await readZipEntry(zip, entry.savePath, MAX_SAVE_BYTES);
      actualTotalSaveBytes += saveBytes.length;
      if (actualTotalSaveBytes > MAX_TOTAL_SAVE_BYTES) throw new ImportLimitError('Catalog archive total save size exceeds the safety limit');
      const metaBytes = await readZipEntry(zip, entry.metaPath, MAX_META_BYTES);
      const actualHash = createHash('sha256').update(saveBytes).digest('hex');
      if (saveBytes.length !== entry.bytes || actualHash !== entry.sha256) throw new ImportRejectedError(`Snapshot ${entry.id} failed manifest hash validation`);
      let metaValue: unknown;
      try { metaValue = JSON.parse(decodeUtf8(metaBytes, `Snapshot ${entry.id} metadata`)) as unknown; }
      catch (error) { if (error instanceof ImportRejectedError) throw error; throw new ImportRejectedError(`Snapshot ${entry.id} metadata is not valid JSON`); }
      const meta = validateSnapshotMeta(metaValue, entry.id);
      if (meta.sha256 !== actualHash || meta.bytes !== saveBytes.length) throw new ImportRejectedError(`Snapshot ${entry.id} failed metadata hash validation`);
      parseSaveBytes(saveBytes);
      if (existingById.has(entry.id) || stagedIds.has(entry.id)) {
        const known = existingById.get(entry.id) ?? staged.find((snapshot) => snapshot.meta.id === entry.id)?.meta;
        if (known?.sha256.toLowerCase() === actualHash) skipped += 1;
        else throw new ImportRejectedError(`Duplicate snapshot id ${entry.id}`);
        continue;
      }
      if (existingByHash.has(actualHash) || stagedHashes.has(actualHash)) {
        skipped += 1;
        continue;
      }
      staged.push({ meta, bytes: saveBytes });
      stagedIds.add(entry.id);
      stagedHashes.add(actualHash);
    } catch (error) {
      if (error instanceof ImportLimitError) throw error;
      errors.push(error instanceof Error ? error.message : `Snapshot ${entry.id} was rejected`);
    }
  }

  if (errors.length > 0) return { ok: false, added: 0, skipped, rejected: errors.length, errors };
  await catalog.commitImportedSnapshots(staged, importedSettings);
  return { ok: true, added: staged.length, skipped, rejected: 0, errors: [] };
}
