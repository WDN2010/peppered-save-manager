import { createHash, randomUUID } from 'node:crypto';
import { access, lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile, replaceAtomically } from './atomic';
import { parseSaveBytes, MAX_SAVE_BYTES } from './es3';
import { validateSettings, validateSnapshotMeta, DEFAULT_SETTINGS } from './metadata';
import { exportCatalog, importCatalog } from './archive';
import { isIsoDate, isValidSaveTarget, isValidSnapshotId, isValidSourcePath, sameFilesystemPath } from './validation';
import type {
  CaptureInput,
  CaptureResult,
  ImportReport,
  RestoreResult,
  Settings,
  SnapshotFile,
  SnapshotKind,
  SnapshotMeta,
  Language,
} from '../shared/types';

const CATALOG_VERSION = 1 as const;

export { isValidSaveTarget, isValidSnapshotId } from './validation';

export class MutationQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

function hashBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function validateTitle(title: string): string {
  const clean = typeof title === 'string' ? title.trim() : '';
  if (clean.length > 160) throw new Error('Snapshot title is too long');
  return clean;
}

async function pathExists(value: string): Promise<boolean> {
  try { await access(value); return true; } catch { return false; }
}

async function assertDirectory(value: string, label: string): Promise<void> {
  const info = await lstat(value);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
}

async function readStableCaptureSource(sourcePath: string): Promise<Buffer> {
  const absoluteSource = path.resolve(sourcePath);
  const parent = path.dirname(absoluteSource);
  const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw new Error('The save folder must be a real directory');
  if (!sameFilesystemPath(await realpath(parent), parent)) throw new Error('The save folder must not resolve through a symlink');
  const before = await lstat(absoluteSource, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('The capture source must be a regular file, not a symlink');
  if (before.size > BigInt(MAX_SAVE_BYTES)) throw new Error('Save exceeds the safety limit');
  const handle = await open(absoluteSource, 'r');
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('The capture source changed while opening');
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs) {
      throw new Error('The capture source changed while it was being read');
    }
    if (bytes.length > MAX_SAVE_BYTES) throw new Error('Save exceeds the safety limit');
    return bytes;
  } finally {
    await handle.close();
  }
}

export class CatalogRepository {
  readonly rootPath: string;
  readonly snapshotsPath: string;
  readonly settingsPath: string;
  private readonly initialLanguage: Language;
  private readonly mutations = new MutationQueue();

  constructor(rootPath: string, options: { defaultLanguage?: Language } = {}) {
    this.rootPath = path.resolve(rootPath);
    this.snapshotsPath = path.join(this.rootPath, 'snapshots');
    this.settingsPath = path.join(this.rootPath, 'settings.json');
    this.initialLanguage = options.defaultLanguage ?? 'en';
  }

  async initialize(): Promise<void> {
    await mkdir(this.rootPath, { recursive: true });
    if (await pathExists(this.snapshotsPath)) await assertDirectory(this.snapshotsPath, 'Snapshots path');
    else await mkdir(this.snapshotsPath);
    if (!(await pathExists(this.settingsPath))) await this.writeSettings({ ...DEFAULT_SETTINGS, language: this.initialLanguage });
  }

  private async writeSettings(settings: Settings): Promise<void> {
    await atomicWriteFile(this.settingsPath, Buffer.from(JSON.stringify(settings, null, 2), 'utf8'));
  }

  async getSettings(): Promise<Settings> {
    await this.initialize();
    try {
      const raw = JSON.parse(await readFile(this.settingsPath, 'utf8')) as unknown;
      const settings = validateSettings(raw, this.initialLanguage);
      if (JSON.stringify(raw) !== JSON.stringify(settings)) await this.writeSettings(settings);
      return settings;
    } catch {
      const settings = { ...DEFAULT_SETTINGS, language: this.initialLanguage };
      await this.writeSettings(settings);
      return settings;
    }
  }

  async updateSettings(patch: Partial<Pick<Settings, 'language' | 'scale' | 'savePath'>>): Promise<Settings> {
    return this.mutations.run(async () => {
      const current = await this.getSettings();
      const next = validateSettings({ ...current, ...patch }, this.initialLanguage);
      await this.writeSettings(next);
      return next;
    });
  }

  private snapshotDirectory(id: string): string {
    if (!isValidSnapshotId(id)) throw new Error('Invalid snapshot id');
    return path.join(this.snapshotsPath, id.toLowerCase());
  }

  private async readMeta(id: string): Promise<SnapshotMeta> {
    const directory = this.snapshotDirectory(id);
    await assertDirectory(directory, 'Snapshot directory');
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path.join(directory, 'meta.json'), 'utf8')) as unknown;
    } catch {
      throw new Error('Snapshot metadata is unavailable');
    }
    return validateSnapshotMeta(parsed, id);
  }

  async listSnapshots(): Promise<SnapshotMeta[]> {
    await this.initialize();
    const entries = await readdir(this.snapshotsPath, { withFileTypes: true });
    const snapshots: SnapshotMeta[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !isValidSnapshotId(entry.name)) continue;
      try {
        const meta = await this.readMeta(entry.name);
        const savePath = path.join(this.snapshotsPath, entry.name, 'save.es3');
        const saveInfo = await lstat(savePath);
        if (!saveInfo.isFile() || saveInfo.isSymbolicLink()) continue;
        const bytes = await readFile(savePath);
        if (bytes.length === meta.bytes && hashBytes(bytes) === meta.sha256) snapshots.push(meta);
      } catch {
        // Corrupt or incomplete entries are quarantined from the renderer by omission.
      }
    }
    return snapshots.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
  }

  async getSnapshot(id: string): Promise<SnapshotFile> {
    const meta = await this.readMeta(id);
    const savePath = path.join(this.snapshotDirectory(id), 'save.es3');
    const saveInfo = await lstat(savePath);
    if (!saveInfo.isFile() || saveInfo.isSymbolicLink()) throw new Error('Snapshot save is not a regular file');
    const bytes = await readFile(savePath);
    if (bytes.length !== meta.bytes || hashBytes(bytes) !== meta.sha256) throw new Error('Snapshot hash verification failed');
    parseSaveBytes(bytes);
    return { meta, bytes };
  }

  private async createSnapshot(snapshot: SnapshotFile): Promise<SnapshotMeta> {
    const meta = validateSnapshotMeta(snapshot.meta, snapshot.meta.id);
    const directory = this.snapshotDirectory(meta.id);
    if (await pathExists(directory)) throw new Error('Snapshot id already exists');
    const temporary = `${directory}.tmp-${randomUUID()}`;
    await mkdir(temporary, { recursive: true });
    try {
      await atomicWriteFile(path.join(temporary, 'save.es3'), snapshot.bytes);
      await atomicWriteFile(path.join(temporary, 'meta.json'), Buffer.from(JSON.stringify(meta, null, 2), 'utf8'));
      await rename(temporary, directory);
      return meta;
    } finally {
      await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async commitImportedSnapshotsInternal(snapshots: SnapshotFile[], importedSettings?: Pick<Settings, 'language' | 'scale'>): Promise<void> {
    const previousSettings = await this.getSettings();
    const normalized = snapshots.map((snapshot) => ({
      meta: validateSnapshotMeta(snapshot.meta, snapshot.meta.id),
      bytes: snapshot.bytes,
    }));
    const ids = new Set<string>();
    for (const snapshot of normalized) {
      if (ids.has(snapshot.meta.id)) throw new Error(`Duplicate snapshot id ${snapshot.meta.id}`);
      ids.add(snapshot.meta.id);
      if (snapshot.bytes.length !== snapshot.meta.bytes || hashBytes(snapshot.bytes) !== snapshot.meta.sha256) throw new Error('Imported snapshot hash verification failed');
      parseSaveBytes(snapshot.bytes);
    }
    const createdIds: string[] = [];
    try {
      for (const snapshot of normalized) {
        await this.createSnapshot(snapshot);
        createdIds.push(snapshot.meta.id);
      }
      if (importedSettings) {
        await this.writeSettings({ ...previousSettings, language: importedSettings.language, scale: importedSettings.scale });
      }
    } catch (error) {
      const rollbackErrors: string[] = [];
      for (const id of createdIds.reverse()) {
        try { await rm(this.snapshotDirectory(id), { recursive: true, force: false }); }
        catch (rollbackError) { rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError)); }
      }
      if (importedSettings) {
        try { await this.writeSettings(previousSettings); }
        catch (rollbackError) { rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError)); }
      }
      if (rollbackErrors.length > 0) throw new Error(`Import commit failed and rollback failed: ${rollbackErrors.join('; ')}`);
      throw error;
    }
  }

  async commitImportedSnapshots(snapshots: SnapshotFile[], importedSettings?: Pick<Settings, 'language' | 'scale'>): Promise<void> {
    return this.mutations.run(() => this.commitImportedSnapshotsInternal(snapshots, importedSettings));
  }

  async addImportedSnapshot(snapshot: SnapshotFile): Promise<void> {
    return this.commitImportedSnapshots([snapshot]);
  }

  private async captureBytes(bytes: Buffer, sourcePath: string, title: string, capturedAt: string, kind: SnapshotKind = 'manual'): Promise<CaptureResult> {
    const parsed = parseSaveBytes(bytes);
    const digest = hashBytes(bytes);
    if (kind === 'manual') {
      for (const existing of await this.listSnapshots()) {
        if (existing.sha256 === digest) return { kind: 'duplicate', snapshot: existing };
      }
    }
    const cleanTitle = kind === 'recovery' ? 'Recovery copy' : validateTitle(title) || parsed.summary.description.en;
    const snapshot: SnapshotMeta = {
      version: CATALOG_VERSION,
      id: randomUUID(),
      title: cleanTitle,
      kind,
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
    if (!input || !isValidSourcePath(input.sourcePath)) throw new Error('Invalid save path');
    const capturedAt = input.capturedAt ?? new Date().toISOString();
    if (!isIsoDate(capturedAt)) throw new Error('Invalid capture time');
    return this.mutations.run(async () => {
      const bytes = await readStableCaptureSource(input.sourcePath);
      return this.captureBytes(bytes, input.sourcePath, input.title, capturedAt);
    });
  }

  async rename(id: string, title: string): Promise<SnapshotMeta> {
    return this.mutations.run(async () => {
      const snapshot = await this.getSnapshot(id);
      const cleanTitle = validateTitle(title);
      if (!cleanTitle) throw new Error('Snapshot title cannot be empty');
      const next = validateSnapshotMeta({ ...snapshot.meta, title: cleanTitle, kind: 'manual' }, id);
      await atomicWriteFile(path.join(this.snapshotDirectory(id), 'meta.json'), Buffer.from(JSON.stringify(next, null, 2), 'utf8'));
      return next;
    });
  }

  async delete(id: string): Promise<void> {
    return this.mutations.run(async () => {
      await this.getSnapshot(id);
      await rm(this.snapshotDirectory(id), { recursive: true, force: false });
    });
  }

  private async validateTarget(targetPath: string): Promise<void> {
    if (!isValidSaveTarget(targetPath)) throw new Error('Choose a valid absolute path ending in Save.es3');
    const parent = path.dirname(path.resolve(targetPath));
    const parentInfo = await lstat(parent).catch(() => null);
    if (!parentInfo || !parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw new Error('The save folder must be a real directory');
    const resolvedParent = await realpath(parent);
    if (!sameFilesystemPath(resolvedParent, parent)) throw new Error('The save folder must not resolve through a symlink');
    try {
      const existing = await lstat(targetPath);
      if (existing.isSymbolicLink() || !existing.isFile()) throw new Error('The active save path must be a regular file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  async restore(id: string, targetPath: string, now = new Date()): Promise<RestoreResult> {
    return this.mutations.run(async () => {
      await this.validateTarget(targetPath);
      const selected = await this.getSnapshot(id);
      let current: Buffer | null = null;
      try { current = await readFile(targetPath); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      let safetySnapshotId: string | null = null;
      const capturedAt = now.toISOString();
      if (current && !current.equals(selected.bytes)) {
        const safety = await this.captureBytes(current, targetPath, 'Recovery copy', capturedAt, 'recovery');
        safetySnapshotId = safety.snapshot.id;
      }
      await replaceAtomically(targetPath, selected.bytes, {
        guardedTargetSha256: current ? hashBytes(current) : null,
        expectedReplacementSha256: selected.meta.sha256,
      });
      return { restored: true, safetySnapshotId };
    });
  }

  async exportCatalog(outputPath: string): Promise<{ snapshotCount: number; bytes: number }> {
    return this.mutations.run(() => exportCatalog(this, outputPath));
  }

  async importCatalog(archivePath: string): Promise<ImportReport> {
    return this.mutations.run(() => importCatalog({
      listSnapshots: () => this.listSnapshots(),
      getSnapshot: (id) => this.getSnapshot(id),
      getSettings: () => this.getSettings(),
      commitImportedSnapshots: (snapshots, importedSettings) => this.commitImportedSnapshotsInternal(snapshots, importedSettings),
    }, archivePath));
  }
}
