import { describe, expect, it } from 'vitest';
import { isValidSaveTarget, isValidSourcePath } from '../src/core/validation';

describe('Windows path validation', () => {
  it('rejects device-namespace save targets and source paths', () => {
    expect(isValidSaveTarget(String.raw`\\?\C:\Games\Save.es3`)).toBe(false);
    expect(isValidSaveTarget(String.raw`\\.\C:\Games\Save.es3`)).toBe(false);
    expect(isValidSaveTarget(String.raw`\\?\UNC\server\share\Games\Save.es3`)).toBe(false);
    expect(isValidSaveTarget(String.raw`\\.\UNC\server\share\Games\Save.es3`)).toBe(false);
    expect(isValidSaveTarget('//?/C:/Games/Save.es3')).toBe(false);
    expect(isValidSaveTarget('//./C:/Games/Save.es3')).toBe(false);

    expect(isValidSourcePath(String.raw`\\?\C:\Games\Save.es3`)).toBe(false);
    expect(isValidSourcePath(String.raw`\\.\C:\Games\Save.es3`)).toBe(false);
    expect(isValidSourcePath(String.raw`\\?\UNC\server\share\Games\Save.es3`)).toBe(false);
    expect(isValidSourcePath(String.raw`\\.\UNC\server\share\Games\Save.es3`)).toBe(false);
    expect(isValidSourcePath('//?/C:/Games/Save.es3')).toBe(false);
    expect(isValidSourcePath('//./C:/Games/Save.es3')).toBe(false);
  });

  it('retains normal drive and UNC path support', () => {
    expect(isValidSaveTarget(String.raw`C:\Games\Save.es3`)).toBe(true);
    expect(isValidSourcePath(String.raw`C:\Games\Save.es3`)).toBe(true);
    expect(isValidSaveTarget(String.raw`\\server\share\Games\Save.es3`)).toBe(true);
    expect(isValidSourcePath(String.raw`\\server\share\Games\Save.es3`)).toBe(true);
  });
});
