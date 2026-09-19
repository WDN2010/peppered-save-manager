import { open, rename, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { sameFilesystemPath } from './validation';

export interface AtomicFileOptions {
  rename?: typeof rename;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : undefined;
}

function isTransientReplaceError(error: unknown): boolean {
  return ['EPERM', 'EACCES', 'EBUSY'].includes(errorCode(error) ?? '');
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function withTempPath(error: unknown, temporary: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  const result = new Error(`${message} Temporary recovery file preserved at ${temporary}`);
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
    if (replacementStarted && !replaced) throw withTempPath(error, temporary);
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

export async function replaceAtomically(targetPath: string, bytes: Buffer, options: AtomicReplaceOptions = {}): Promise<void> {
  const expected = await assertStableReplacementPath(targetPath, options);
  const temporary = path.join(expected.parent, `.peppered-tmp-${randomUUID()}`);
  const renameFile = options.rename ?? rename;
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
    await assertReplacementIdentity(targetPath, expected, options);
    replacementStarted = true;
    let attempt = 0;
    while (true) {
      try {
        await renameFile(temporary, targetPath);
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
    if (replacementStarted && !replaced) throw withTempPath(error, temporary);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  if (replaced) await unlink(temporary).catch((error: unknown) => {
    if (errorCode(error) !== 'ENOENT') throw error;
  });
}
