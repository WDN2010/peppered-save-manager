import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { inspectLiveSave } from '../src/core/live';
import type { LiveSaveStatus } from '../src/shared/ipc';

const fixturePath = path.resolve('tests/fixtures/sample-save.es3');

function codedError(code: string, message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function expectStatus(status: LiveSaveStatus, state: LiveSaveStatus['state'], message: string) {
  expect(status).toMatchObject({ state, summary: null, message });
}

describe('production live-save inspection', () => {
  it('uses the stable reader and detects a valid save', async () => {
    const bytes = await readFile(fixturePath);
    const calls: string[] = [];
    const status = await inspectLiveSave(fixturePath, async (sourcePath) => {
      calls.push(sourcePath);
      return bytes;
    });
    expect(status.state).toBe('detected');
    expect(status.summary?.description.en).toBe('Elevator area');
    expect(calls).toEqual([fixturePath]);
  });

  it('classifies a persistent sharing lock as busy, not unreadable', async () => {
    const status = await inspectLiveSave('C:\\Users\\Player\\Save.es3', async () => {
      throw codedError('EBUSY', 'resource busy or locked');
    });
    expectStatus(status, 'busy', 'busy');
  });

  it('classifies permission denial separately from a sharing lock', async () => {
    const status = await inspectLiveSave('C:\\Users\\Player\\Save.es3', async () => {
      throw codedError('EACCES', 'EACCES: permission denied, open Save.es3');
    });
    expectStatus(status, 'permission', 'permission');
  });

  it('keeps parser failures invalid and missing files missing', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'peppered-live-'));
    const invalidPath = path.join(root, 'Save.es3');
    await writeFile(invalidPath, Buffer.from('{"unsupported":true}'));
    expectStatus(await inspectLiveSave(invalidPath), 'invalid', 'invalid');
    expectStatus(await inspectLiveSave(path.join(root, 'missing', 'Save.es3')), 'missing', 'missing');
  });
});
