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

const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_END_SIGNATURE = 0x06054b50;
const ZIP_END_BYTES = 22;
const ZIP_MAX_COMMENT_BYTES = 0xffff;

function readCentralDirectoryEntryNames(archive: Buffer): string[] {
  let endOffset = -1;
  const minimumOffset = Math.max(0, archive.length - ZIP_END_BYTES - ZIP_MAX_COMMENT_BYTES);
  for (let offset = archive.length - ZIP_END_BYTES; offset >= minimumOffset; offset -= 1) {
    if (archive.readUInt32LE(offset) === ZIP_END_SIGNATURE
      && offset + ZIP_END_BYTES + archive.readUInt16LE(offset + 20) === archive.length) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) throw new ImportRejectedError('Catalog archive has no canonical ZIP directory');
  const disk = archive.readUInt16LE(endOffset + 4);
  const directoryDisk = archive.readUInt16LE(endOffset + 6);
  const entriesOnDisk = archive.readUInt16LE(endOffset + 8);
  const entryCount = archive.readUInt16LE(endOffset + 10);
  const directoryBytes = archive.readUInt32LE(endOffset + 12);
  const directoryOffset = archive.readUInt32LE(endOffset + 16);
  if (disk !== 0 || directoryDisk !== 0 || entriesOnDisk !== entryCount
    || entryCount === 0xffff || directoryBytes === 0xffffffff || directoryOffset === 0xffffffff) {
    throw new ImportRejectedError('Catalog archive uses unsupported multi-disk or ZIP64 metadata');
  }
  const directoryEnd = directoryOffset + directoryBytes;
  if (directoryEnd !== endOffset || directoryEnd > archive.length) throw new ImportRejectedError('Catalog archive ZIP directory is inconsistent');

  const names: string[] = [];
  let offset = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > directoryEnd || archive.readUInt32LE(offset) !== ZIP_CENTRAL_SIGNATURE) {
      throw new ImportRejectedError('Catalog archive ZIP directory is malformed');
    }
    const nameBytes = archive.readUInt16LE(offset + 28);
    const extraBytes = archive.readUInt16LE(offset + 30);
    const commentBytes = archive.readUInt16LE(offset + 32);
    const recordBytes = 46 + nameBytes + extraBytes + commentBytes;
    if (nameBytes < 1 || offset + recordBytes > directoryEnd) throw new ImportRejectedError('Catalog archive ZIP entry is malformed');
    const rawName = archive.subarray(offset + 46, offset + 46 + nameBytes);
    if ([...rawName].some((byte) => byte < 0x20 || byte > 0x7e)) throw new ImportRejectedError('Catalog archive entry names must be canonical ASCII');
    names.push(rawName.toString('ascii'));
    offset += recordBytes;
  }
  if (offset !== directoryEnd || new Set(names).size !== names.length) throw new ImportRejectedError('Catalog archive contains duplicate ZIP entries');
  return names;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function snapshotHashKey(meta: Pick<SnapshotMeta, 'kind' | 'sha256'>): string {
  return `${meta.kind}:${meta.sha256.toLowerCase()}`;
}

function sameSnapshotIdentity(left: SnapshotMeta, right: SnapshotMeta): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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
  const centralEntryNames = readCentralDirectoryEntryNames(archive);
  if (centralEntryNames.length > MAX_ENTRIES * 3 + 3) throw new ImportRejectedError('Catalog archive has too many entries');
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(archive, { checkCRC32: true, createFolders: false }); }
  catch { throw new ImportRejectedError('Catalog archive is not a readable ZIP archive'); }
  const entries = Object.values(zip.files);
  for (const [name, entry] of Object.entries(zip.files)) {
    const originalName = (entry as JSZip.JSZipObject & { unsafeOriginalName?: string }).unsafeOriginalName ?? name;
    assertSafeArchivePath(originalName, 'archive entry');
    if (entry.dir && (name === 'snapshots/' || /^snapshots\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/$/i.test(name))) continue;
    if (name !== 'manifest.json' && name !== 'settings.json' && !/^snapshots\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/(save\.es3|meta\.json)$/i.test(name)) throw new ImportRejectedError(`Unexpected archive entry ${name}`);
  }
  if (entries.length !== centralEntryNames.length || !centralEntryNames.every((name) => Object.hasOwn(zip.files, name))) {
    throw new ImportRejectedError('Catalog archive ZIP entries are ambiguous');
  }
  const manifestBytes = await readZipEntry(zip, 'manifest.json', MAX_META_BYTES);
  let manifestValue: unknown;
  try { manifestValue = JSON.parse(decodeUtf8(manifestBytes, 'Catalog manifest')) as unknown; }
  catch (error) { if (error instanceof ImportRejectedError) throw error; throw new ImportRejectedError('Catalog manifest is not valid JSON'); }
  const manifest = validateManifest(manifestValue);
  const expectedEntries = new Set<string>(['manifest.json', manifest.settingsPath]);
  for (const snapshot of manifest.snapshots) {
    expectedEntries.add('snapshots/');
    expectedEntries.add(`snapshots/${snapshot.id}/`);
    expectedEntries.add(snapshot.savePath);
    expectedEntries.add(snapshot.metaPath);
  }
  const actualEntries = Object.keys(zip.files);
  const unexpectedEntries = actualEntries.filter((name) => !expectedEntries.has(name));
  const missingEntries = [...expectedEntries].filter((name) => !Object.hasOwn(zip.files, name));
  if (unexpectedEntries.length > 0 || missingEntries.length > 0 || actualEntries.length !== expectedEntries.size) {
    throw new ImportRejectedError('Catalog archive contains unreferenced or missing entries');
  }
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
  const existingByKindHash = new Set(existing.map((snapshot) => snapshotHashKey(snapshot)));
  const staged: SnapshotFile[] = [];
  const stagedById = new Map<string, SnapshotMeta>();
  const stagedKindHashes = new Set<string>();
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
      if (existingById.has(entry.id) || stagedById.has(entry.id)) {
        const known = existingById.get(entry.id) ?? stagedById.get(entry.id);
        if (known && sameSnapshotIdentity(known, meta) && known.sha256.toLowerCase() === actualHash) skipped += 1;
        else throw new ImportRejectedError(`Duplicate snapshot id ${entry.id} has conflicting metadata`);
        continue;
      }
      const kindHash = snapshotHashKey(meta);
      if (existingByKindHash.has(kindHash) || stagedKindHashes.has(kindHash)) {
        skipped += 1;
        continue;
      }
      staged.push({ meta, bytes: saveBytes });
      stagedById.set(entry.id, meta);
      stagedKindHashes.add(kindHash);
    } catch (error) {
      if (error instanceof ImportLimitError) throw error;
      errors.push(error instanceof Error ? error.message : `Snapshot ${entry.id} was rejected`);
    }
  }

  if (errors.length > 0) return { ok: false, added: 0, skipped, rejected: errors.length, errors };
  await catalog.commitImportedSnapshots(staged, importedSettings);
  return { ok: true, added: staged.length, skipped, rejected: 0, errors: [] };
}
