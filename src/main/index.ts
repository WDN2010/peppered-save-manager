import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { CatalogRepository, isValidSaveTarget, isValidSnapshotId } from '../core/catalog';
import { parseSaveBytes } from '../core/es3';
import type { AppState, CaptureResponse, LiveSaveStatus, RestoreResponse } from '../shared/ipc';
import type { Language, Settings, UiScale } from '../shared/types';
import { readFile } from 'node:fs/promises';

const execFileAsync = promisify(execFile);
const DEFAULT_RELATIVE_SAVE = path.join('AppData', 'LocalLow', 'Mostly Games', 'PEPPERED', 'Save.es3');
const MAX_TITLE = 160;

function defaultSavePath(): string {
  const profile = process.env.USERPROFILE ?? process.env.HOME ?? '';
  return path.join(profile, DEFAULT_RELATIVE_SAVE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Invalid ${label}`);
}

function assertId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !isValidSnapshotId(value)) throw new Error('Invalid snapshot id');
}

function assertTitle(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_TITLE) throw new Error('Enter a shorter snapshot title');
}

function serializeError(error: unknown): Error {
  if (error instanceof Error && error.message.length < 300) return new Error(error.message);
  return new Error('The requested action could not be completed.');
}

async function gameIsRunning(): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  try {
    const result = await execFileAsync('tasklist.exe', ['/FO', 'CSV', '/NH'], { timeout: 2_500, windowsHide: true, maxBuffer: 1_000_000 });
    return /"(?:PEPPERED|PEPPERED-Win64-Shipping|PEPPERED\.exe)[^"]*"/i.test(result.stdout);
  } catch {
    throw new Error('Could not verify that PEPPERED is closed. Close the game and try again.');
  }
}

export function registerIpc(catalog: CatalogRepository): void {
  const getSettings = () => catalog.getSettings();
  const resolveActivePath = (settings: Settings) => settings.savePath ?? defaultSavePath();

  const readLive = async (activePath: string): Promise<LiveSaveStatus> => {
    try {
      const bytes = await readFile(activePath);
      const parsed = parseSaveBytes(bytes);
      return { state: 'detected', path: activePath, summary: parsed.summary, message: null };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { state: 'missing', path: activePath, summary: null, message: 'missing' };
      if (error instanceof Error && /supported|valid JSON|empty/i.test(error.message)) return { state: 'invalid', path: activePath, summary: null, message: 'invalid' };
      return { state: 'unreadable', path: activePath, summary: null, message: 'unreadable' };
    }
  };

  const getState = async (): Promise<AppState> => {
    const settings = await getSettings();
    const activePath = resolveActivePath(settings);
    return { settings, defaultPath: defaultSavePath(), activePath, live: await readLive(activePath), snapshots: await catalog.listSnapshots() };
  };

  ipcMain.handle('app:get-state', async () => getState());
  ipcMain.handle('app:choose-save-path', async () => {
    const picked = await dialog.showOpenDialog({ properties: ['openFile'], title: 'Choose PEPPERED Save.es3', filters: [{ name: 'PEPPERED save', extensions: ['es3'] }] });
    if (picked.canceled || picked.filePaths.length !== 1) return null;
    const selected = picked.filePaths[0];
    if (!isValidSaveTarget(selected)) throw new Error('Choose a file named Save.es3');
    await catalog.updateSettings({ savePath: selected });
    return getState();
  });
  ipcMain.handle('app:set-settings', async (_event, input: unknown) => {
    assertObject(input, 'settings');
    const patch: { language?: Language; scale?: UiScale } = {};
    if (input.language !== undefined) {
      if (input.language !== 'en' && input.language !== 'ru') throw new Error('Invalid language');
      patch.language = input.language;
    }
    if (input.scale !== undefined) {
      if (input.scale !== 100 && input.scale !== 115 && input.scale !== 130) throw new Error('Invalid scale');
      patch.scale = input.scale;
    }
    await catalog.updateSettings(patch);
    return getState();
  });
  ipcMain.handle('app:capture', async (_event, input: unknown): Promise<CaptureResponse> => {
    assertObject(input, 'capture');
    assertTitle(input.title);
    const settings = await getSettings();
    const result = await catalog.capture({ sourcePath: resolveActivePath(settings), title: input.title });
    return { kind: result.kind, snapshot: result.snapshot, state: await getState() };
  });
  ipcMain.handle('app:rename', async (_event, input: unknown) => {
    assertObject(input, 'rename');
    assertId(input.id);
    assertTitle(input.title);
    await catalog.rename(input.id, input.title);
    return getState();
  });
  ipcMain.handle('app:delete', async (_event, input: unknown) => {
    assertObject(input, 'delete');
    assertId(input.id);
    await catalog.delete(input.id);
    return getState();
  });
  ipcMain.handle('app:restore', async (_event, input: unknown): Promise<RestoreResponse> => {
    assertObject(input, 'restore');
    assertId(input.id);
    if (await gameIsRunning()) throw new Error('Close PEPPERED before restoring a checkpoint.');
    const settings = await getSettings();
    const result = await catalog.restore(input.id, resolveActivePath(settings));
    return { state: await getState(), safetySnapshotId: result.safetySnapshotId };
  });
  ipcMain.handle('app:export', async () => {
    const picked = await dialog.showSaveDialog({ title: 'Export PEPPERED catalog', defaultPath: 'peppered-catalog.peppered-saves', filters: [{ name: 'PEPPERED catalog', extensions: ['peppered-saves'] }] });
    if (picked.canceled || !picked.filePath) throw new Error('Export cancelled');
    return catalog.exportCatalog(picked.filePath);
  });
  ipcMain.handle('app:import', async () => {
    const picked = await dialog.showOpenDialog({ title: 'Import PEPPERED catalog', properties: ['openFile'], filters: [{ name: 'PEPPERED catalog', extensions: ['peppered-saves', 'zip'] }] });
    if (picked.canceled || picked.filePaths.length !== 1) throw new Error('Import cancelled');
    return catalog.importCatalog(picked.filePaths[0]);
  });
}

let mainWindow: BrowserWindow | null = null;
let appCatalog: CatalogRepository | null = null;
let ipcRegistered = false;

async function createWindow(): Promise<void> {
  if (!appCatalog) appCatalog = new CatalogRepository(path.join(app.getPath('userData'), 'catalog-v1'));
  await appCatalog.initialize();
  if (!ipcRegistered) {
    registerIpc(appCatalog);
    ipcRegistered = true;
  }
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 720,
    minWidth: 860,
    minHeight: 560,
    backgroundColor: '#141414',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  if (process.env.ELECTRON_RENDERER_URL) await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  else await mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(createWindow).catch((error) => {
  dialog.showErrorBox('PEPPERED Save Manager', serializeError(error).message);
  app.quit();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
