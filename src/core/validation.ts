import path from 'node:path';

export const SNAPSHOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const SHA256 = /^[0-9a-f]{64}$/i;
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export function canonicalSnapshotId(value: unknown): string | null {
  return typeof value === 'string' && SNAPSHOT_ID.test(value) ? value.toLowerCase() : null;
}

export function isValidSnapshotId(value: unknown): value is string {
  return canonicalSnapshotId(value) !== null;
}

export function canonicalSha256(value: unknown): string | null {
  return typeof value === 'string' && SHA256.test(value) ? value.toLowerCase() : null;
}

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  const normalized = new Date(timestamp).toISOString();
  return value === normalized || value === normalized.replace('.000Z', 'Z');
}

export function isValidSaveTarget(targetPath: unknown): targetPath is string {
  if (typeof targetPath !== 'string' || targetPath.length < 2 || targetPath.length > 4_000) return false;
  const absolute = path.isAbsolute(targetPath) || /^[A-Za-z]:[\\/]/.test(targetPath) || targetPath.startsWith('\\\\');
  return absolute && path.basename(targetPath).toLowerCase() === 'save.es3';
}

export function sameFilesystemPath(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return process.platform === 'win32' ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase() : normalizedLeft === normalizedRight;
}

export function isValidSourcePath(sourcePath: unknown): sourcePath is string {
  if (typeof sourcePath !== 'string' || sourcePath.length < 1 || sourcePath.length > 4_000) return false;
  return path.isAbsolute(sourcePath) || /^[A-Za-z]:[\\/]/.test(sourcePath) || sourcePath.startsWith('\\\\');
}
