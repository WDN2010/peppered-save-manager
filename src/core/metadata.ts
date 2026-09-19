import type { Language, PositionSummary, SaveSummary, Settings, SnapshotMeta, UiScale } from '../shared/types';
import { isIsoDate, isValidSaveTarget, isValidSourcePath, canonicalSha256, canonicalSnapshotId } from './validation';

export const DEFAULT_SETTINGS: Settings = { version: 1, language: 'en', scale: 100, savePath: null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function integer(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}

function nullableFinite(value: unknown): value is number | null {
  return value === null || finiteNumber(value);
}

function nullableInteger(value: unknown, minimum = 0): value is number | null {
  return value === null || integer(value, minimum);
}

function isPosition(value: unknown): value is PositionSummary | null {
  if (value === null) return true;
  return isRecord(value) && finiteNumber(value.x) && finiteNumber(value.y) && finiteNumber(value.z);
}

function isIntegerMap(value: unknown): value is Record<string, number> | null {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  return Object.values(value).every((entry) => integer(entry));
}

function isDescription(value: unknown): value is { en: string; ru: string } {
  return isRecord(value)
    && typeof value.en === 'string' && value.en.trim().length > 0 && value.en.length <= 240
    && typeof value.ru === 'string' && value.ru.trim().length > 0 && value.ru.length <= 240;
}

export function validateSaveSummary(value: unknown): SaveSummary {
  if (!isRecord(value)
    || !('sceneCode' in value) || !(value.sceneCode === null || (typeof value.sceneCode === 'string' && value.sceneCode.length <= 160))
    || !isPosition(value.position)
    || !nullableInteger(value.deathCount)
    || !isIntegerMap(value.chapter)
    || !nullableInteger(value.regret)
    || !nullableInteger(value.abyssState)
    || !nullableInteger(value.choiceCount)
    || !nullableInteger(value.inventoryCount)
    || !nullableInteger(value.stars)
    || !nullableInteger(value.coins)
    || !isIntegerMap(value.greenGem)
    || !nullableInteger(value.enemyCount)
    || !nullableInteger(value.track)
    || !nullableFinite(value.volume)
    || !isDescription(value.description)
    || !('title' in value)
    || !(value.title === null || (typeof value.title === 'string' && value.title.length <= 160))) {
    throw new Error('Snapshot summary is invalid');
  }
  return {
    sceneCode: value.sceneCode as string | null,
    position: value.position as PositionSummary | null,
    deathCount: value.deathCount as number | null,
    chapter: value.chapter as Record<string, number> | null,
    regret: value.regret as number | null,
    abyssState: value.abyssState as number | null,
    choiceCount: value.choiceCount as number | null,
    inventoryCount: value.inventoryCount as number | null,
    stars: value.stars as number | null,
    coins: value.coins as number | null,
    greenGem: value.greenGem as Record<string, number> | null,
    enemyCount: value.enemyCount as number | null,
    track: value.track as number | null,
    volume: value.volume as number | null,
    description: value.description as { en: string; ru: string },
    title: value.title as string | null,
  };
}

export function validateSnapshotMeta(value: unknown, expectedId?: string): SnapshotMeta {
  if (!isRecord(value) || value.version !== 1) throw new Error('Snapshot metadata is invalid');
  const id = canonicalSnapshotId(value.id);
  const expected = expectedId ? canonicalSnapshotId(expectedId) : null;
  const sha256 = canonicalSha256(value.sha256);
  const bytes = value.bytes;
  if (!id || (expected && id !== expected)
    || typeof value.title !== 'string' || value.title.trim().length === 0 || value.title.length > 160
    || !isIsoDate(value.capturedAt)
    || !isValidSourcePath(value.sourcePath)
    || !sha256
    || typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > 16 * 1024 * 1024
    || (value.kind !== 'manual' && value.kind !== 'recovery')) {
    throw new Error('Snapshot metadata is invalid');
  }
  const summary = validateSaveSummary(value.summary);
  return {
    version: 1,
    id,
    title: value.title.trim(),
    kind: value.kind,
    capturedAt: value.capturedAt,
    sourcePath: value.sourcePath,
    sha256,
    bytes,
    summary,
  };
}

export function validateSettings(value: unknown, defaultLanguage: Language = 'en'): Settings {
  if (!isRecord(value) || value.version !== 1) return { ...DEFAULT_SETTINGS, language: defaultLanguage };
  const language: Language = value.language === 'ru' ? 'ru' : value.language === 'en' ? 'en' : defaultLanguage;
  const scale: UiScale = value.scale === 115 || value.scale === 130 ? value.scale : 100;
  const savePath = value.savePath === null ? null : isValidSaveTarget(value.savePath) ? value.savePath : null;
  return { version: 1, language, scale, savePath };
}
