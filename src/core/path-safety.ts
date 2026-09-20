import type { BigIntStats } from 'node:fs';
import { lstat as defaultLstat, realpath as defaultRealpath } from 'node:fs/promises';
import path from 'node:path';

export type BigIntLstat = (value: string, options: { bigint: true }) => Promise<BigIntStats>;

const defaultBigIntLstat: BigIntLstat = (value, options) => defaultLstat(value, options);

export interface SafeDirectoryPathOptions {
  lstat?: BigIntLstat;
  realpath?: typeof defaultRealpath;
}

type FilesystemIdentity = Pick<BigIntStats, 'dev' | 'ino'>;

function assertExactIdentity(info: FilesystemIdentity, message: string): void {
  if (typeof info.dev !== 'bigint' || typeof info.ino !== 'bigint') throw new Error(message);
}

function sameFilesystemObject(left: FilesystemIdentity, right: FilesystemIdentity): boolean {
  return typeof left.dev === 'bigint'
    && typeof left.ino === 'bigint'
    && typeof right.dev === 'bigint'
    && typeof right.ino === 'bigint'
    && left.dev === right.dev
    && left.ino === right.ino;
}

async function assertNoSymlinkComponents(directory: string, statPath: BigIntLstat, linkMessage: string): Promise<void> {
  const absolute = path.resolve(directory);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  const relative = path.relative(parsed.root, absolute);
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const info = await statPath(current, { bigint: true });
    assertExactIdentity(info, linkMessage);
    if (info.isSymbolicLink()) throw new Error(linkMessage);
  }
}

export async function assertSafeDirectoryPath(
  directory: string,
  options: SafeDirectoryPathOptions = {},
  messages: { notDirectory?: string; symlink?: string } = {},
): Promise<BigIntStats> {
  const statPath = options.lstat ?? defaultBigIntLstat;
  const resolvePath = options.realpath ?? defaultRealpath;
  const notDirectoryMessage = messages.notDirectory ?? 'The save folder must be a real directory';
  const symlinkMessage = messages.symlink ?? 'The save folder must not resolve through a symlink';
  const info = await statPath(directory, { bigint: true });
  assertExactIdentity(info, symlinkMessage);
  if (info.isSymbolicLink()) throw new Error(symlinkMessage);
  if (!info.isDirectory()) throw new Error(notDirectoryMessage);

  // realpath() spelling is not an identity check on Windows: it may expand
  // 8.3 names, case, or other benign aliases. Inspect every component first,
  // then compare the directory identities behind both spellings.
  await assertNoSymlinkComponents(directory, statPath, symlinkMessage);
  const resolved = await resolvePath(directory);
  const resolvedInfo = await statPath(resolved, { bigint: true });
  assertExactIdentity(resolvedInfo, symlinkMessage);
  if (!sameFilesystemObject(info, resolvedInfo)) throw new Error(symlinkMessage);
  return info;
}

export async function assertSafeExistingPath(
  value: string,
  options: SafeDirectoryPathOptions = {},
  symlinkMessage = 'The path must not resolve through a symlink',
): Promise<BigIntStats> {
  const statPath = options.lstat ?? defaultBigIntLstat;
  const resolvePath = options.realpath ?? defaultRealpath;
  const info = await statPath(value, { bigint: true });
  assertExactIdentity(info, symlinkMessage);
  if (info.isSymbolicLink()) throw new Error(symlinkMessage);
  await assertNoSymlinkComponents(value, statPath, symlinkMessage);
  const resolved = await resolvePath(value);
  const resolvedInfo = await statPath(resolved, { bigint: true });
  assertExactIdentity(resolvedInfo, symlinkMessage);
  if (!sameFilesystemObject(info, resolvedInfo)) throw new Error(symlinkMessage);
  return info;
}
