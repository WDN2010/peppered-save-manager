import type { ImportReport, Language, SaveSummary, Settings, SnapshotMeta, UiScale } from './types';

export interface LiveSaveStatus {
  state: 'detected' | 'missing' | 'invalid' | 'unreadable';
  path: string;
  summary: SaveSummary | null;
  message: string | null;
}

export interface AppState {
  settings: Settings;
  defaultPath: string;
  activePath: string;
  live: LiveSaveStatus;
  snapshots: SnapshotMeta[];
}

export interface CaptureResponse {
  kind: 'created' | 'duplicate';
  snapshot: SnapshotMeta;
  state: AppState;
}

export interface RestoreResponse {
  state: AppState;
  safetySnapshotId: string | null;
}

export interface RendererApi {
  getState(): Promise<AppState>;
  chooseSavePath(): Promise<AppState | null>;
  setSettings(patch: { language?: Language; scale?: UiScale }): Promise<AppState>;
  capture(title: string): Promise<CaptureResponse>;
  rename(id: string, title: string): Promise<AppState>;
  delete(id: string): Promise<AppState>;
  restore(id: string): Promise<RestoreResponse>;
  exportCatalog(): Promise<{ snapshotCount: number; bytes: number }>;
  importCatalog(): Promise<ImportReport>;
}

declare global {
  interface Window {
    peppered: RendererApi;
  }
}
