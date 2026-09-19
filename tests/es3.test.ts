import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import {
  describeCheckpoint,
  parseSaveBytes,
  parseSaveText,
  supportedSaveShape,
} from '../src/core/es3';

const fixture = new URL('./fixtures/sample-save.es3', import.meta.url);

const sample = `{
  "LvlName": {"_ES3Type":"string","value":"A_5"},
  "Pos": {"_ES3Type":"Vector3","value":{"x":1,"y":2,"z":3}},
  "DeathCount": {"_ES3Type":"int","value":7},
  "Choices": {"_ES3Type":"Dictionary","value":{"door":"left"}}
}`;

describe('PEPPERED Easy Save 3 parsing', () => {
  it('extracts defensive wrapper values and useful metadata', async () => {
    const parsed = parseSaveBytes(await readFile(fixture));
    expect(parsed.summary.sceneCode).toBe('A_7');
    expect(parsed.summary.deathCount).toBe(3);
    expect(parsed.summary.chapter).toBe(1);
    expect(parsed.summary.position).toEqual({ x: 12.5, y: 2, z: -4 });
    expect(parsed.summary.choiceCount).toBe(1);
    expect(parsed.summary.inventoryCount).toBe(2);
  });

  it('fails softly for malformed optional values while requiring JSON and core shape', () => {
    const parsed = parseSaveText(sample);
    expect(parsed.summary.sceneCode).toBe('A_5');
    expect(parsed.summary.deathCount).toBe(7);
    expect(() => parseSaveText('{not json')).toThrow('valid JSON');
    expect(() => parseSaveText('{"unrelated":true}')).toThrow('supported PEPPERED');
    expect(supportedSaveShape({ LvlName: null })).toBe(true);
  });

  it('humanizes known and generic scenes in both languages', () => {
    expect(describeCheckpoint('A_7', 'en')).toBe('Elevator area');
    expect(describeCheckpoint('A_7', 'ru')).toBe('Зона лифта');
    expect(describeCheckpoint('Office_1', 'en')).toBe('Opening office');
    expect(describeCheckpoint('G_End', 'ru')).toBe('Финал');
    expect(describeCheckpoint('A_5', 'en')).toBe('Scene A-5');
    expect(describeCheckpoint('A_5', 'ru')).toBe('Сцена A-5');
    expect(describeCheckpoint(undefined, 'en')).toBe('Unknown checkpoint');
  });

  it('uses a user title as the primary checkpoint label', () => {
    const parsed = parseSaveText(sample);
    expect(parsed.summary.description.en).toBe('Scene A-5');
    expect(parsed.summary.description.ru).toBe('Сцена A-5');
    expect(parsed.summary.title ?? null).toBeNull();
  });
});
