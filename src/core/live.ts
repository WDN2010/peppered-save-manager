import { readStableSave, isSaveBusyError, isSavePermissionDeniedError } from './catalog';
import { parseSaveBytes } from './es3';
import type { LiveSaveStatus } from '../shared/ipc';

export type StableSaveReader = (sourcePath: string) => Promise<Buffer>;

function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error ? String((error as NodeJS.ErrnoException).code ?? '') : '';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isInvalidSaveError(error: unknown): boolean {
  return /supported|valid JSON|UTF-8|empty|safety limit|real directory|symlink|regular file/i.test(errorMessage(error));
}

export async function inspectLiveSave(activePath: string, read: StableSaveReader = readStableSave): Promise<LiveSaveStatus> {
  try {
    const parsed = parseSaveBytes(await read(activePath));
    return { state: 'detected', path: activePath, summary: parsed.summary, message: null };
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { state: 'missing', path: activePath, summary: null, message: 'missing' };
    if (isSaveBusyError(error)) return { state: 'busy', path: activePath, summary: null, message: 'busy' };
    if (isSavePermissionDeniedError(error)) return { state: 'permission', path: activePath, summary: null, message: 'permission' };
    if (isInvalidSaveError(error)) return { state: 'invalid', path: activePath, summary: null, message: 'invalid' };
    return { state: 'unreadable', path: activePath, summary: null, message: 'unreadable' };
  }
}
