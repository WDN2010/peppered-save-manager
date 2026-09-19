export type Language = 'en' | 'ru';
export type UiScale = 100 | 115 | 130;

export interface PositionSummary {
  x: number;
  y: number;
  z: number;
}

export interface CheckpointDescription {
  en: string;
  ru: string;
}

export interface SaveSummary {
  sceneCode: string | null;
  position: PositionSummary | null;
  deathCount: number | null;
  chapter: number | string | null;
  regret: boolean | null;
  abyssState: string | null;
  choiceCount: number | null;
  inventoryCount: number | null;
  stars: number | null;
  coins: number | null;
  greenGem: number | null;
  enemyCount: number | null;
  track: string | null;
  volume: number | null;
  description: CheckpointDescription;
  title?: string | null;
}

export interface SnapshotMeta {
  version: 1;
  id: string;
  title: string;
  capturedAt: string;
  sourcePath: string;
  sha256: string;
  bytes: number;
  summary: SaveSummary;
}

export interface Settings {
  version: 1;
  language: Language;
  scale: UiScale;
  savePath: string | null;
}

export interface CaptureInput {
  sourcePath: string;
  title: string;
  capturedAt?: string;
}

export interface SnapshotFile {
  meta: SnapshotMeta;
  bytes: Buffer;
}

export type CaptureResult =
  | { kind: 'created'; snapshot: SnapshotMeta }
  | { kind: 'duplicate'; snapshot: SnapshotMeta };

export interface RestoreResult {
  restored: true;
  safetySnapshotId: string | null;
}

export interface ImportReport {
  ok: boolean;
  added: number;
  skipped: number;
  rejected: number;
  errors: string[];
}
