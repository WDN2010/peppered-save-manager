import { describe, expect, it, vi } from 'vitest';
import { parsePepperedTasklist, verifyPepperedClosed } from '../src/core/windows-processes';

function row(imageName: string, pid: number): string {
  return `"${imageName}","${pid}","Console","1","50,000 K"`;
}

describe('Windows PEPPERED process detection', () => {
  it('does not mistake the save manager for the game', () => {
    expect(parsePepperedTasklist(row('PEPPERED Save Manager.exe', 1000))).toBe('not-running');
  });

  it('recognizes only the exact supported game image names, case-insensitively', () => {
    expect(parsePepperedTasklist(row('PEPPERED.exe', 1001))).toBe('running');
    expect(parsePepperedTasklist(row('peppered-WIN64-shipping.EXE', 1002))).toBe('running');
    expect(parsePepperedTasklist(row('PEPPERED-helper.exe', 1003))).toBe('not-running');
    expect(parsePepperedTasklist(row('PEPPERED-Win64-Shipping-debug.exe', 1004))).toBe('not-running');
  });

  it('checks only the tasklist image-name field across CRLF rows', () => {
    const output = [
      row('explorer.exe', 2000),
      '"cmd.exe","2001","PEPPERED.exe","1","10,000 K"',
      row('PEPPERED-Win64-Shipping.exe', 2002),
    ].join('\r\n');
    expect(parsePepperedTasklist(output)).toBe('running');
    expect(parsePepperedTasklist(output.replace(row('PEPPERED-Win64-Shipping.exe', 2002), row('steam.exe', 2002)))).toBe('not-running');
  });

  it('fails closed on empty, malformed, or partially malformed successful output', () => {
    expect(parsePepperedTasklist('')).toBe('unverified');
    expect(parsePepperedTasklist('PEPPERED.exe,1234\r\nINFO: no tasks')).toBe('unverified');
    expect(parsePepperedTasklist(`${row('explorer.exe', 2000)}\r\nmalformed`)).toBe('unverified');
    expect(parsePepperedTasklist('"PEPPERED Save Manager.exe",garbage')).toBe('unverified');
    expect(parsePepperedTasklist('"PEPPERED Save Manager.exe",')).toBe('unverified');
    expect(parsePepperedTasklist(`${row('PEPPERED Save Manager.exe', 2001)} trailing`)).toBe('unverified');
  });
});

describe('restore process gate', () => {
  it('allows restore when tasklist is valid and only the manager is running', async () => {
    await expect(verifyPepperedClosed('win32', async () => row('PEPPERED Save Manager.exe', 3000))).resolves.toBeUndefined();
  });

  it('blocks restore when either supported game process is running', async () => {
    await expect(verifyPepperedClosed('win32', async () => row('PEPPERED.exe', 3001))).rejects.toThrow(/Close PEPPERED/i);
    await expect(verifyPepperedClosed('win32', async () => row('PEPPERED-Win64-Shipping.exe', 3002))).rejects.toThrow(/Close PEPPERED/i);
  });

  it('fails closed when tasklist errors or returns unusable output', async () => {
    await expect(verifyPepperedClosed('win32', async () => '')).rejects.toThrow(/Could not verify/i);
    await expect(verifyPepperedClosed('win32', async () => 'malformed')).rejects.toThrow(/Could not verify/i);
    await expect(verifyPepperedClosed('win32', async () => { throw new Error('tasklist failed'); })).rejects.toThrow(/Could not verify/i);
  });

  it('does not invoke tasklist on unsupported development hosts', async () => {
    const tasklist = vi.fn(async () => row('PEPPERED.exe', 3003));
    await expect(verifyPepperedClosed('linux', tasklist)).resolves.toBeUndefined();
    expect(tasklist).not.toHaveBeenCalled();
  });
});
