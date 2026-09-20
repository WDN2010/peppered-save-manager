import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, open, readFile, rename, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { sameFilesystemPath } from './validation';

export interface AtomicFileOptions {
  rename?: typeof rename;
}

type WindowsGuardedReplace = (target: string, temporary: string, expectedTargetSha256: string | null, expectedReplacementSha256: string) => Promise<void>;

const execFileAsync = promisify(execFile);

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : undefined;
}

function isTransientReplaceError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (/ROLLBACK_FAILED_WIN32_/i.test(message)) return false;
  return ['EPERM', 'EACCES', 'EBUSY'].includes(errorCode(error) ?? '');
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function normalizeWindowsHelperDetail(detail: string): string {
  const marker = detail.match(/(?:^|\s)BACKUP_PRESERVED_AT[ \t]+([^\r\n]+)/i);
  if (!marker) return detail;
  const normalized = `BACKUP_PRESERVED_AT ${marker[1].trim()}`;
  return detail.replace(/BACKUP_PRESERVED_AT[ \t]+[^\r\n]+/i, normalized);
}

async function resolveWindowsReplaceHelper(): Promise<string> {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = [
    resourcesPath ? path.join(resourcesPath, 'helpers', 'replace-save.ps1') : null,
    path.resolve(process.cwd(), 'resources', 'replace-save.ps1'),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch { /* Try the next packaged/development location. */ }
  }
  throw new Error('Windows guarded replacement helper is missing');
}

async function runWindowsGuardedReplace(
  target: string,
  temporary: string,
  expectedTargetSha256: string | null,
  expectedReplacementSha256: string,
): Promise<void> {
  const helper = await resolveWindowsReplaceHelper();
  try {
    await execFileAsync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', helper,
      '-TargetPath', target,
      '-TemporaryPath', temporary,
      '-ExpectedTargetSha256', expectedTargetSha256 ?? 'ABSENT',
      '-ExpectedReplacementSha256', expectedReplacementSha256,
    ], { windowsHide: true, timeout: 20_000, maxBuffer: 256 * 1024 });
  } catch (error) {
    const detail = error instanceof Error && 'stderr' in error
      ? String((error as Error & { stderr?: unknown }).stderr ?? '').trim() || error.message
      : String(error);
    const normalizedDetail = normalizeWindowsHelperDetail(detail);
    const concurrent = /TARGET_CHANGED|TARGET_APPEARED/i.test(normalizedDetail);
    const rollbackFailed = /ROLLBACK_FAILED_WIN32_/i.test(normalizedDetail);
    const wrapped = new Error(concurrent
      ? 'The active save changed while restore was being prepared; no replacement was made.'
      : `Windows guarded replacement failed: ${normalizedDetail}`) as NodeJS.ErrnoException;
    wrapped.cause = error;
    if (!rollbackFailed && /WIN32_(32|33)|sharing|FILE_LOCK_FAILED/i.test(normalizedDetail)) wrapped.code = 'EBUSY';
    else if (concurrent) wrapped.code = 'ECONCURRENT';
    throw wrapped;
  }
}

async function withTempPath(error: unknown, temporary: string): Promise<Error> {
  const message = error instanceof Error ? error.message : String(error);
  const temporaryExists = await access(temporary).then(() => true, () => false);
  const evidence = temporaryExists ? ` Temporary recovery file preserved at ${temporary}` : '';
  const result = new Error(`${message}${evidence}`);
  result.name = error instanceof Error ? error.name : 'AtomicReplaceError';
  (result as Error & { cause?: unknown }).cause = error;
  return result;
}

async function closeQuietly(handle: Awaited<ReturnType<typeof open>> | null): Promise<void> {
  if (!handle) return;
  await handle.close().catch(() => undefined);
}

export async function atomicWriteFile(destination: string, bytes: Buffer, options: AtomicFileOptions = {}): Promise<void> {
  const temporary = `${destination}.tmp-${randomUUID()}`;
  const renameFile = options.rename ?? rename;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let replacementStarted = false;
  let replaced = false;
  try {
    handle = await open(temporary, 'wx');
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    replacementStarted = true;
    await renameFile(temporary, destination);
    replaced = true;
  } catch (error) {
    await closeQuietly(handle);
    if (replacementStarted && !replaced) throw await withTempPath(error, temporary);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  if (replaced) await unlink(temporary).catch((error: unknown) => {
    if (errorCode(error) !== 'ENOENT') throw error;
  });
}

export interface AtomicReplaceOptions extends AtomicFileOptions {
  lstat?: typeof import('node:fs/promises').lstat;
  realpath?: typeof import('node:fs/promises').realpath;
  retries?: number;
  guardedTargetSha256?: string | null;
  expectedReplacementSha256?: string;
  platform?: NodeJS.Platform;
  windowsGuardedReplace?: WindowsGuardedReplace;
}

async function assertStableReplacementPath(targetPath: string, options: AtomicReplaceOptions): Promise<{
  parent: string;
  parentIdentity: { dev?: number; ino?: number };
  targetIdentity: { dev?: number; ino?: number } | null;
}> {
  const { lstat, realpath } = await import('node:fs/promises');
  const statPath = options.lstat ?? lstat;
  const resolvePath = options.realpath ?? realpath;
  const absoluteTarget = path.resolve(targetPath);
  const parent = path.dirname(absoluteTarget);
  const parentInfo = await statPath(parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw new Error('The save folder must not be a symlink');
  const resolvedParent = await resolvePath(parent);
  if (!sameFilesystemPath(resolvedParent, parent)) throw new Error('The save folder must not resolve through a symlink');
  let targetIdentity: { dev?: number; ino?: number } | null = null;
  try {
    const targetInfo = await statPath(absoluteTarget);
    if (targetInfo.isSymbolicLink() || !targetInfo.isFile()) throw new Error('The active save path must be a regular file');
    targetIdentity = { dev: targetInfo.dev, ino: targetInfo.ino };
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
  return { parent, parentIdentity: { dev: parentInfo.dev, ino: parentInfo.ino }, targetIdentity };
}

async function assertReplacementIdentity(targetPath: string, expected: Awaited<ReturnType<typeof assertStableReplacementPath>>, options: AtomicReplaceOptions): Promise<void> {
  const actual = await assertStableReplacementPath(targetPath, options);
  if (actual.parentIdentity.dev !== expected.parentIdentity.dev || actual.parentIdentity.ino !== expected.parentIdentity.ino) throw new Error('The save folder changed while restoring');
  if (Boolean(actual.targetIdentity) !== Boolean(expected.targetIdentity)) throw new Error('The active save changed while restoring');
  if (actual.targetIdentity && expected.targetIdentity && (actual.targetIdentity.dev !== expected.targetIdentity.dev || actual.targetIdentity.ino !== expected.targetIdentity.ino)) throw new Error('The active save changed while restoring');
}

async function assertGuardedContents(targetPath: string, temporary: string, expectedTargetSha256: string | null, expectedReplacementSha256: string): Promise<void> {
  if (sha256(await readFile(temporary)) !== expectedReplacementSha256) throw new Error('Temporary replacement changed before commit');
  try {
    const currentSha256 = sha256(await readFile(targetPath));
    if (expectedTargetSha256 === null || currentSha256 !== expectedTargetSha256) {
      const error = new Error('The active save changed while restore was being prepared; no replacement was made.') as NodeJS.ErrnoException;
      error.code = 'ECONCURRENT';
      throw error;
    }
  } catch (error) {
    if (errorCode(error) === 'ENOENT' && expectedTargetSha256 === null) return;
    throw error;
  }
}

export async function replaceAtomically(targetPath: string, bytes: Buffer, options: AtomicReplaceOptions = {}): Promise<void> {
  const expected = await assertStableReplacementPath(targetPath, options);
  const temporary = path.join(expected.parent, `.peppered-tmp-${randomUUID()}`);
  const renameFile = options.rename ?? rename;
  const windowsGuardedReplace = options.windowsGuardedReplace ?? runWindowsGuardedReplace;
  const platform = options.platform ?? process.platform;
  const guarded = Object.prototype.hasOwnProperty.call(options, 'guardedTargetSha256');
  const replacementSha256 = options.expectedReplacementSha256 ?? sha256(bytes);
  if (guarded && replacementSha256 !== sha256(bytes)) throw new Error('Replacement hash does not match the supplied bytes');
  const retries = Math.max(0, Math.min(options.retries ?? 4, 8));
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let replacementStarted = false;
  let replaced = false;
  try {
    handle = await open(temporary, 'wx');
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    replacementStarted = true;
    let attempt = 0;
    while (true) {
      try {
        await assertReplacementIdentity(targetPath, expected, options);
        if (guarded && platform === 'win32') {
          await windowsGuardedReplace(targetPath, temporary, options.guardedTargetSha256 ?? null, replacementSha256);
        } else {
          if (guarded) await assertGuardedContents(targetPath, temporary, options.guardedTargetSha256 ?? null, replacementSha256);
          await renameFile(temporary, targetPath);
        }
        break;
      } catch (error) {
        if (!isTransientReplaceError(error) || attempt >= retries) throw error;
        attempt += 1;
        await wait(25 * (2 ** (attempt - 1)));
      }
    }
    replaced = true;
  } catch (error) {
    await closeQuietly(handle);
    if (replacementStarted && !replaced) throw await withTempPath(error, temporary);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  if (replaced) await unlink(temporary).catch((error: unknown) => {
    if (errorCode(error) !== 'ENOENT') throw error;
  });
}
