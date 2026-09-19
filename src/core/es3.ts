import type { Language, PositionSummary, SaveSummary } from '../shared/types';

export const MAX_SAVE_BYTES = 16 * 1024 * 1024;
export const ES3_KEYS = [
  'LvlName', 'Pos', 'DeathCount', 'Chapter', 'Regret', 'Abyss_State', 'Choices',
  'TheStuff', 'Stars', 'Coins', 'Green Gem', 'Enemies', 'Track', 'Volume',
] as const;

const KNOWN_SCENES: Record<string, { en: string; ru: string }> = {
  Office_1: { en: 'Opening office', ru: 'Начало: офис' },
  A_1: { en: 'Start of A', ru: 'Начало главы A' },
  A_7: { en: 'Elevator area', ru: 'Зона лифта' },
  B_0: { en: 'Start of B', ru: 'Начало главы B' },
  G_0: { en: 'Start of G', ru: 'Начало главы G' },
  G_End: { en: 'Finale', ru: 'Финал' },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function unwrapEs3(value: unknown): unknown {
  let current = value;
  for (let depth = 0; depth < 12; depth += 1) {
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, 'value')) return current;
    current = current.value;
  }
  return current;
}

function safeString(value: unknown, maxLength = 160): string | null {
  const unwrapped = unwrapEs3(value);
  if (typeof unwrapped !== 'string') return null;
  const clean = unwrapped.trim();
  return clean.length > 0 && clean.length <= maxLength ? clean : null;
}

function safeNumber(value: unknown): number | null {
  const unwrapped = unwrapEs3(value);
  return typeof unwrapped === 'number' && Number.isFinite(unwrapped) ? unwrapped : null;
}

function safeInteger(value: unknown): number | null {
  const number = safeNumber(value);
  return number !== null && Number.isSafeInteger(number) ? number : null;
}

function safeRecord(value: unknown): Record<string, unknown> | null {
  const unwrapped = unwrapEs3(value);
  return isRecord(unwrapped) ? unwrapped : null;
}

function integerMap(value: unknown): Record<string, number> | null {
  const record = safeRecord(value);
  if (!record) return null;
  const result: Record<string, number> = {};
  for (const [key, entry] of Object.entries(record)) {
    const number = safeInteger(entry);
    if (number === null) return null;
    result[key] = number;
  }
  return result;
}

function countContainer(value: unknown): number | null {
  const unwrapped = unwrapEs3(value);
  if (Array.isArray(unwrapped)) return unwrapped.length;
  if (isRecord(unwrapped)) return Object.keys(unwrapped).length;
  return null;
}

function extractPosition(value: unknown): PositionSummary | null {
  const unwrapped = unwrapEs3(value);
  if (Array.isArray(unwrapped) && unwrapped.length >= 3) {
    const [x, y, z] = unwrapped.slice(0, 3).map((item) => safeNumber(item));
    return x !== null && y !== null && z !== null ? { x, y, z } : null;
  }
  const record = safeRecord(unwrapped);
  if (!record) return null;
  const x = safeNumber(record.x ?? record.X);
  const y = safeNumber(record.y ?? record.Y);
  const z = safeNumber(record.z ?? record.Z);
  return x !== null && y !== null && z !== null ? { x, y, z } : null;
}

export function supportedSaveShape(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  return safeString(value.LvlName) !== null && extractPosition(value.Pos) !== null;
}

export function describeCheckpoint(sceneCode: string | null | undefined, language: Language): string {
  const normalized = typeof sceneCode === 'string' ? sceneCode.trim().slice(0, 160) : '';
  if (!normalized) return language === 'ru' ? 'Неизвестная точка' : 'Unknown checkpoint';
  const known = KNOWN_SCENES[normalized];
  if (known) return known[language];
  const generic = /^([A-Za-z]+)_(\d+)$/.exec(normalized);
  if (generic) {
    return language === 'ru' ? `Сцена ${generic[1].toUpperCase()}-${generic[2]}` : `Scene ${generic[1].toUpperCase()}-${generic[2]}`;
  }
  if (/^[A-Za-z]+_End$/i.test(normalized)) return language === 'ru' ? 'Финальная сцена' : 'Final scene';
  return language === 'ru' ? 'Пользовательская точка' : 'Custom checkpoint';
}

export function parseSaveDocument(document: unknown): SaveSummary {
  if (!supportedSaveShape(document)) throw new Error('Not a supported PEPPERED Easy Save 3 document');
  const sceneCode = safeString(document.LvlName);
  const summary: SaveSummary = {
    sceneCode,
    position: extractPosition(document.Pos),
    deathCount: safeInteger(document.DeathCount),
    chapter: integerMap(document.Chapter),
    regret: safeInteger(document.Regret),
    abyssState: safeInteger(document.Abyss_State),
    choiceCount: countContainer(document.Choices),
    inventoryCount: countContainer(document.TheStuff),
    stars: safeInteger(document.Stars),
    coins: safeInteger(document.Coins),
    greenGem: integerMap(document['Green Gem']),
    enemyCount: countContainer(document.Enemies),
    track: safeInteger(document.Track),
    volume: safeNumber(document.Volume),
    description: {
      en: describeCheckpoint(sceneCode, 'en'),
      ru: describeCheckpoint(sceneCode, 'ru'),
    },
    title: null,
  };
  return summary;
}

export function parseSaveText(text: string): { summary: SaveSummary; document: Record<string, unknown> } {
  if (typeof text !== 'string' || text.trim().length === 0) throw new Error('Save is empty');
  let document: unknown;
  try {
    document = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('Save is not valid JSON');
  }
  if (!supportedSaveShape(document)) throw new Error('Save is not a supported PEPPERED Easy Save 3 document');
  return { summary: parseSaveDocument(document), document };
}

export function parseSaveBytes(bytes: Buffer): { summary: SaveSummary; document: Record<string, unknown> } {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new Error('Save is empty');
  if (bytes.length > MAX_SAVE_BYTES) throw new Error('Save exceeds the safety limit');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('Save is not valid UTF-8');
  }
  return parseSaveText(text);
}
