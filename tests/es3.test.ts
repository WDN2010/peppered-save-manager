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
  "LvlName": {"__type":"string","value":"A_5"},
  "Pos": {"__type":"Vector3","value":{"x":1,"y":2,"z":3}},
  "DeathCount": {"__type":"int","value":7},
  "Chapter": {"__type":"Dictionary<string,int>","value":{"main":2}},
  "Regret": {"__type":"int","value":1},
  "Abyss_State": {"__type":"int","value":4},
  "Green Gem": {"__type":"Dictionary<string,int>","value":{"blue":3}},
  "Track": {"__type":"int","value":9},
  "Choices": {"__type":"Dictionary","value":{"door":"left"}}
}`;

describe('PEPPERED Easy Save 3 parsing', () => {
  it('extracts actual __type wrapper values and useful metadata', async () => {
    const parsed = parseSaveBytes(await readFile(fixture));
    expect(parsed.summary.sceneCode).toBe('A_7');
    expect(parsed.summary.deathCount).toBe(3);
    expect(parsed.summary.chapter).toEqual({ main: 1 });
    expect(parsed.summary.regret).toBe(0);
    expect(parsed.summary.abyssState).toBe(2);
    expect(parsed.summary.position).toEqual({ x: 12.5, y: 2, z: -4 });
    expect(parsed.summary.choiceCount).toBe(1);
    expect(parsed.summary.inventoryCount).toBe(2);
    expect(parsed.summary.track).toBe(7);
    expect(parsed.summary.greenGem).toEqual({ blue: 1 });
  });

  it('accepts direct primitive fallback but requires a meaningful scene and position', () => {
    const parsed = parseSaveText(sample);
    expect(parsed.summary.sceneCode).toBe('A_5');
    expect(parsed.summary.deathCount).toBe(7);
    expect(parsed.summary.chapter).toEqual({ main: 2 });
    expect(() => parseSaveText('{not json')).toThrow('valid JSON');
    expect(() => parseSaveText('{"LvlName":"A_1"}')).toThrow('supported PEPPERED');
    expect(() => parseSaveText('{"Pos":{"x":1,"y":2,"z":3}}')).toThrow('supported PEPPERED');
    expect(supportedSaveShape({ LvlName: 'A_1', Pos: [0, 0, 0] })).toBe(true);
  });

  it('rejects invalid UTF-8 before JSON parsing', () => {
    expect(() => parseSaveBytes(Buffer.from([0xff, 0xfe, 0xfd]))).toThrow('UTF-8');
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
    expect(parsed.summary.title).toBeNull();
  });
});
