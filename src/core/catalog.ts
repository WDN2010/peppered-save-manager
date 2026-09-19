import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseSaveBytes } from './es3';
import { exportCatalog, importCatalog } from './archive';
import type {
  CaptureInput,
  CaptureResult,
  ImportReport,
  RestoreResult,
  Settings,
  SnapshotFile,
  SnapshotMeta,
  UiScale,
  Language,
} from '../shared/types';

const CATALOG_VERSION = 1 as const;
const DEFAULT_SETTINGS: Settings = { version: CATALOG_VERSION, language: 'en', scale: 100, savePath: null };
const SNAPSHOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;

export function isValidSnapshotId(id: string): boolean {
  return typeof id === 'string' && SNAPSHOT_ID.test(id);
}

export function isValidSaveTarget(targetPath: string): boolean {
  if (typeof targetPath !== 'string' || targetPath.length < 2 || targetPath.length > 4_000) return false;
  const absolute = path.isAbsolute(targetPath) || /^[A-Za-z]:[\\/]/.test(targetPath) || targetPath.startsWith('\\\\');
  return absolute && path.basename(targetPath).toLowerCase() === 'save.es3';
}

function hashBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function validateTitle(title: string): string {
  const clean = typeof title === 'string' ? title.trim() : '';
  if (clean.length > 160) throw new Error('Snapshot title is too long');
  return clean;
}

function validateSettings(value: unknown): Settings {
  if (typeof value !== 'object' || value === null) return { ...DEFAULT_SETTINGS };
  const record = value as Record<string, unknown>;
  const language: Language = record.language === 'ru' ? 'ru' : 'en';
  const scale: UiScale = record.scale === 115 || record.scale === 130 ? record.scale : 100;
  const savePath = typeof record.savePath === 'string' && record.savePath.length <= 4_000 ? record.savePath : null;
  return { version: CATALOG_VERSION, language, scale, savePath };
}

async function pathExists(value: string): Promise<boolean> {
  try { await access(value); return true; } catch { return false; }
}

export class CatalogRepository {
  readonly rootPath: string;
  readonly snapshotsPath: string;
  readonly settingsPath: string;

  constructor(rootPath: string) {
    this.rootPath = path.resolve(rootPath);
    this.snapshotsPath = path.join(this.rootPath, 'snapshots');
    this.settingsPath = path.join(this.rootPath, 'settings.json');
  }

  async initialize(): Promise<void> {
    await mkdir(this.snapshotsPath, { recursive: true });
    if (!(await pathExists(this.settingsPath))) await this.writeSettings(DEFAULT_SETTINGS);
  }

  private async writeSettings(settings: Settings): Promise<void> {
    await this.atomicWrite(this.settingsPath, Buffer.from(JSON.stringify(settings, null, 2), 'utf8'));
  }

  async getSettings(): Promise<Settings> {
    await this.initialize();
    try {
      const raw = JSON.parse((await readFile(this.settingsPath, 'utf8')));
      const settings = validateSettings(raw);
      if (JSON.stringify(raw) !== JSON.stringify(settings)) await this.writeSettings(settings);
      return settings;
    } catch {
      await this.writeSettings(DEFAULT_SETTINGS);
      return { ...DEFAULT_SETTINGS };
    }
  }

  async updateSettings(patch: Partial<Pick<Settings, 'language' | 'scale' | 'savePath'>>): Promise<Settings> {
    const current = await this.getSettings();
    const next = validateSettings({ ...current, ...patch });
    await this.writeSettings(next);
    return next;
  }

  private snapshotDirectory(id: string): string {
    if (!isValidSnapshotId(id)) throw new Error('Invalid snapshot id');
    return path.join(this.snapshotsPath, id);
  }

  private async readMeta(id: string): Promise<SnapshotMeta> {
    const directory = this.snapshotDirectory(id);
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(path.join(directory, 'meta.json'), 'utf8')); } catch { throw new Error('Snapshot metadata is unavailable'); }
    if (typeof parsed !== 'object' || parsed === null) throw new Error('Snapshot metadata is invalid');
    const meta = parsed as Partial<SnapshotMeta>;
    if (meta.version !== 1 || meta.id !== id || typeof meta.title !== 'string' || typeof meta.capturedAt !== 'string' || typeof meta.sourcePath !== 'string' || typeof meta.sha256 !== 'string' || !SHA256.test(meta.sha256) || typeof meta.bytes !== 'number' || !Number.isSafeInteger(meta.bytes) || meta.bytes < 1 || !meta.summary) throw new Error('Snapshot metadata is invalid');
    return meta as SnapshotMeta;
  }

  async listSnapshots(): Promise<SnapshotMeta[]> {
    await this.initialize();
    const entries = await readdir(this.snapshotsPath, { withFileTypes: true });
    const snapshots: SnapshotMeta[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !isValidSnapshotId(entry.name)) continue;
      try {
        const meta = await this.readMeta(entry.name);
        const bytes = await readFile(path.join(this.snapshotsPath, entry.name, 'save.es3'));
        if (bytes.length === meta.bytes && hashBytes(bytes) === meta.sha256) snapshots.push(meta);
      } catch {
        // An incomplete catalog entry is never surfaced as a usable snapshot.
      }
    }
    return snapshots.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
  }

  async getSnapshot(id: string): Promise<SnapshotFile> {
    const meta = await this.readMeta(id);
    const bytes = await readFile(path.join(this.snapshotDirectory(id), 'save.es3'));
    if (bytes.length !== meta.bytes || hashBytes(bytes) !== meta.sha256) throw new Error('Snapshot hash verification failed');
    parseSaveBytes(bytes);
    return { meta, bytes };
  }

  private async atomicWrite(destination: string, bytes: Buffer): Promise<void> {
    const temp = `${destination}.tmp-${randomUUID()}`;
    try {
      await writeFile(temp, bytes, { flag: 'wx' });
      await rename(temp, destination);
    } finally {
      await rm(temp, { force: true }).catch(() => undefined);
    }
  }

  private async createSnapshot(snapshot: SnapshotFile): Promise<SnapshotMeta> {
    const directory = this.snapshotDirectory(snapshot.meta.id);
    if (await pathExists(directory)) throw new Error('Snapshot id already exists');
    const temporary = `${directory}.tmp-${randomUUID()}`;
    await mkdir(temporary, { recursive: true });
    try {
      await writeFile(path.join(temporary, 'save.es3'), snapshot.bytes, { flag: 'wx' });
      await writeFile(path.join(temporary, 'meta.json'), JSON.stringify(snapshot.meta, null, 2), { flag: 'wx' });
      await rename(temporary, directory);
      return snapshot.meta;
    } finally {
      await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async addImportedSnapshot(snapshot: SnapshotFile): Promise<void> {
    if (!isValidSnapshotId(snapshot.meta.id)) throw new Error('Invalid snapshot id');
    if (hashBytes(snapshot.bytes) !== snapshot.meta.sha256 || snapshot.bytes.length !== snapshot.meta.bytes) throw new Error('Imported snapshot hash verification failed');
    parseSaveBytes(snapshot.bytes);
    await this.initialize();
    await this.createSnapshot(snapshot);
  }

  private async captureBytes(bytes: Buffer, sourcePath: string, title: string, capturedAt: string): Promise<CaptureResult> {
    const parsed = parseSaveBytes(bytes);
    const digest = hashBytes(bytes);
    for (const existing of await this.listSnapshots()) {
      if (existing.sha256 === digest) return { kind: 'duplicate', snapshot: existing };
    }
    const cleanTitle = validateTitle(title) || parsed.summary.description.en;
    const snapshot: SnapshotMeta = {
      version: CATALOG_VERSION,
      id: randomUUID(),
      title: cleanTitle,
      capturedAt,
      sourcePath,
      sha256: digest,
      bytes: bytes.length,
      summary: parsed.summary,
    };
    await this.createSnapshot({ meta: snapshot, bytes });
    return { kind: 'created', snapshot };
  }

  async capture(input: CaptureInput): Promise<CaptureResult> {
    if (!input || typeof input.sourcePath !== 'string' || input.sourcePath.length === 0 || input.sourcePath.length > 4_000) throw new Error('Invalid save path');
    const capturedAt = input.capturedAt ?? new Date().toISOString();
    if (Number.isNaN(Date.parse(capturedAt))) throw new Error('Invalid capture time');
    const bytes = await readFile(input.sourcePath);
    return this.captureBytes(bytes, input.sourcePath, input.title, capturedAt);
  }

  async rename(id: string, title: string): Promise<SnapshotMeta> {
    const snapshot = await this.getSnapshot(id);
    const cleanTitle = validateTitle(title);
    if (!cleanTitle) throw new Error('Snapshot title cannot be empty');
    const next = { ...snapshot.meta, title: cleanTitle };
    await this.atomicWrite(path.join(this.snapshotDirectory(id), 'meta.json'), Buffer.from(JSON.stringify(next, null, 2), 'utf8'));
    return next;
  }

  async delete(id: string): Promise<void> {
    await this.getSnapshot(id);
    await rm(this.snapshotDirectory(id), { recursive: true, force: false });
  }

  private async validateTarget(targetPath: string): Promise<void> {
    if (!isValidSaveTarget(targetPath)) throw new Error('Choose a valid absolute path ending in Save.es3');
    const parent = path.dirname(targetPath);
    let parentInfo;
    try { parentInfo = await stat(parent); } catch { throw new Error('The save folder does not exist'); }
    if (!parentInfo.isDirectory()) throw new Error('The save folder is not a directory');
    try {
      const existing = await stat(targetPath);
      if (!existing.isFile()) throw new Error('The active save path is not a file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private async replaceAtomically(targetPath: string, bytes: Buffer): Promise<void> {
    const temporary = `${targetPath}.peppered-tmp-${randomUUID()}`;
    await writeFile(temporary, bytes, { flag: 'wx' });
    try {
      try {
        await rename(temporary, targetPath);
      } catch (error) {
        // Windows does not replace an existing file with rename. Move the old
        // file aside only after the verified recovery snapshot exists, then
        // roll back if the second rename cannot complete.
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' && (error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
        const displaced = `${targetPath}.peppered-old-${randomUUID()}`;
        await rename(targetPath, displaced);
        try {
          await rename(temporary, targetPath);
        } catch (replaceError) {
          await rename(displaced, targetPath).catch(() => undefined);
          throw replaceError;
        }
        await rm(displaced, { force: true });
      }
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async restore(id: string, targetPath: string, now = new Date()): Promise<RestoreResult> {
    await this.validateTarget(targetPath);
    const selected = await this.getSnapshot(id);
    let current: Buffer | null = null;
    try { current = await readFile(targetPath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    let safetySnapshotId: string | null = null;
    if (current && !current.equals(selected.bytes)) {
      const safety = await this.captureBytes(current, targetPath, `Recovery copy · ${now.toISOString()}`, now.toISOString());
      safetySnapshotId = safety.snapshot.id;
    }
    await this.replaceAtomically(targetPath, selected.bytes);
    return { restored: true, safetySnapshotId };
  }

  async exportCatalog(outputPath: string): Promise<{ snapshotCount: number; bytes: number }> {
    return exportCatalog(this, outputPath);
  }

  async importCatalog(archivePath: string): Promise<ImportReport> {
    return importCatalog(this, archivePath);
  }
}
