import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CatalogRepository, isValidSaveTarget, isValidSnapshotId } from '../core/catalog';
import { ImportRejectedError } from '../core/archive';
import { MAX_SAVE_BYTES, parseSaveBytes } from '../core/es3';
import { sameFilesystemPath } from '../core/validation';
import type { AppState, CaptureResponse, LiveSaveStatus, RestoreAndLaunchResponse, RestoreResponse } from '../shared/ipc';
import type { Language, Settings, UiScale } from '../shared/types';
import { lstat, readFile, realpath } from 'node:fs/promises';

const execFileAsync = promisify(execFile);
const DEFAULT_RELATIVE_SAVE = path.join('AppData', 'LocalLow', 'Mostly Games', 'PEPPERED', 'Save.es3');
const PEPPERED_STEAM_URI = 'steam://rungameid/1883370';
const MAX_TITLE = 160;
const DIALOG_COPY = {
  en: {
    appName: 'PEPPERED Save Manager',
    choose: 'Choose PEPPERED Save.es3',
    chooseFilter: 'PEPPERED save',
    save: 'Export PEPPERED catalog',
    load: 'Import PEPPERED catalog',
    saveFilter: 'PEPPERED catalog',
    startupError: 'The application could not start. Check the catalog folder and try again.',
  },
  ru: {
    appName: 'PEPPERED Save Manager',
    choose: 'Выберите Save.es3 PEPPERED',
    chooseFilter: 'Сохранение PEPPERED',
    save: 'Экспорт каталога PEPPERED',
    load: 'Импорт каталога PEPPERED',
    saveFilter: 'Каталог PEPPERED',
    startupError: 'Не удалось запустить приложение. Проверьте каталог и повторите попытку.',
  },
} as const;

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

function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
  } catch { return false; }
}

export function isTrustedRendererUrl(value: string, devUrl: string | undefined, trustedFileUrl: string): boolean {
  if (devUrl) {
    if (!isLoopbackUrl(devUrl) || !isLoopbackUrl(value)) return false;
    try { return new URL(devUrl).origin === new URL(value).origin; } catch { return false; }
  }
  return value === trustedFileUrl;
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
  const trustedFileUrl = pathToFileURL(path.join(__dirname, '../renderer/index.html')).href;
  const devUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
  const assertTrustedSender = (event: Electron.IpcMainInvokeEvent): void => {
    if (!event.senderFrame || !isTrustedRendererUrl(event.senderFrame.url, devUrl, trustedFileUrl)) throw new Error('Untrusted renderer');
  };
  const getSettings = () => catalog.getSettings();
  const resolveActivePath = (settings: Settings) => settings.savePath ?? defaultSavePath();

  const readLive = async (activePath: string): Promise<LiveSaveStatus> => {
    try {
      const parent = path.dirname(path.resolve(activePath));
      const parentInfo = await lstat(parent);
      const info = await lstat(activePath);
      if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || !sameFilesystemPath(await realpath(parent), parent) || !info.isFile() || info.isSymbolicLink() || info.size > MAX_SAVE_BYTES) {
        return { state: 'invalid', path: activePath, summary: null, message: 'invalid' };
      }
      const bytes = await readFile(activePath);
      const parsed = parseSaveBytes(bytes);
      return { state: 'detected', path: activePath, summary: parsed.summary, message: null };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { state: 'missing', path: activePath, summary: null, message: 'missing' };
      if (error instanceof Error && /supported|valid JSON|UTF-8|empty|safety limit/i.test(error.message)) return { state: 'invalid', path: activePath, summary: null, message: 'invalid' };
      return { state: 'unreadable', path: activePath, summary: null, message: 'unreadable' };
    }
  };

  const getState = async (): Promise<AppState> => {
    const settings = await getSettings();
    const activePath = resolveActivePath(settings);
    return { settings, defaultPath: defaultSavePath(), activePath, live: await readLive(activePath), snapshots: await catalog.listSnapshots() };
  };

  ipcMain.handle('app:get-state', async (event) => { assertTrustedSender(event); return getState(); });
  ipcMain.handle('app:choose-save-path', async (event) => {
    assertTrustedSender(event);
    const settings = await getSettings();
    const copy = DIALOG_COPY[settings.language];
    const picked = await dialog.showOpenDialog({ properties: ['openFile'], title: copy.choose, filters: [{ name: copy.chooseFilter, extensions: ['es3'] }] });
    if (picked.canceled || picked.filePaths.length !== 1) return null;
    const selected = picked.filePaths[0];
    if (!isValidSaveTarget(selected)) throw new Error('Choose a file named Save.es3');
    await catalog.updateSettings({ savePath: selected });
    return getState();
  });
  ipcMain.handle('app:set-settings', async (event, input: unknown) => {
    assertTrustedSender(event);
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
  ipcMain.handle('app:capture', async (event, input: unknown): Promise<CaptureResponse> => {
    assertTrustedSender(event);
    assertObject(input, 'capture');
    assertTitle(input.title);
    const settings = await getSettings();
    const result = await catalog.capture({ sourcePath: resolveActivePath(settings), title: input.title });
    return { kind: result.kind, snapshot: result.snapshot, state: await getState() };
  });
  ipcMain.handle('app:rename', async (event, input: unknown) => {
    assertTrustedSender(event);
    assertObject(input, 'rename');
    assertId(input.id);
    assertTitle(input.title);
    await catalog.rename(input.id, input.title);
    return getState();
  });
  ipcMain.handle('app:delete', async (event, input: unknown) => {
    assertTrustedSender(event);
    assertObject(input, 'delete');
    assertId(input.id);
    await catalog.delete(input.id);
    return getState();
  });
  const restoreCheckpoint = async (id: string): Promise<RestoreResponse> => {
    if (await gameIsRunning()) throw new Error('Close PEPPERED before restoring a checkpoint.');
    const settings = await getSettings();
    const result = await catalog.restore(id, resolveActivePath(settings));
    return { state: await getState(), safetySnapshotId: result.safetySnapshotId };
  };
  ipcMain.handle('app:restore', async (event, input: unknown): Promise<RestoreResponse> => {
    assertTrustedSender(event);
    assertObject(input, 'restore');
    assertId(input.id);
    return restoreCheckpoint(input.id);
  });
  ipcMain.handle('app:restore-and-launch', async (event, input: unknown): Promise<RestoreAndLaunchResponse> => {
    assertTrustedSender(event);
    assertObject(input, 'restore and launch');
    assertId(input.id);
    const restored = await restoreCheckpoint(input.id);
    try {
      await shell.openExternal(PEPPERED_STEAM_URI, { activate: true });
      return { ...restored, launchRequested: true };
    } catch {
      return { ...restored, launchRequested: false };
    }
  });
  ipcMain.handle('app:export', async (event) => {
    assertTrustedSender(event);
    const settings = await getSettings();
    const copy = DIALOG_COPY[settings.language];
    const picked = await dialog.showSaveDialog({ title: copy.save, defaultPath: 'peppered-catalog.peppered-saves', filters: [{ name: copy.saveFilter, extensions: ['peppered-saves'] }] });
    if (picked.canceled || !picked.filePath) throw new Error('Export cancelled');
    return catalog.exportCatalog(picked.filePath);
  });
  ipcMain.handle('app:import', async (event) => {
    assertTrustedSender(event);
    const settings = await getSettings();
    const copy = DIALOG_COPY[settings.language];
    const picked = await dialog.showOpenDialog({ title: copy.load, properties: ['openFile'], filters: [{ name: copy.saveFilter, extensions: ['peppered-saves', 'zip'] }] });
    if (picked.canceled || picked.filePaths.length !== 1) throw new Error('Import cancelled');
    try {
      return await catalog.importCatalog(picked.filePaths[0]);
    } catch (error) {
      if (error instanceof ImportRejectedError) return error.report;
      throw error;
    }
  });
}

let mainWindow: BrowserWindow | null = null;
let appCatalog: CatalogRepository | null = null;
let ipcRegistered = false;

async function createWindow(): Promise<void> {
  if (!appCatalog) {
    const defaultLanguage: Language = app.getLocale().toLowerCase().startsWith('ru') ? 'ru' : 'en';
    appCatalog = new CatalogRepository(path.join(app.getPath('userData'), 'catalog-v1'), { defaultLanguage });
  }
  await appCatalog.initialize();
  if (!ipcRegistered) {
    registerIpc(appCatalog);
    ipcRegistered = true;
  }
  const rendererUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
  if (rendererUrl && !isLoopbackUrl(rendererUrl)) throw new Error('Development renderer must use a loopback URL');
  const icon = path.join(app.getAppPath(), 'build', 'icon.ico');
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 720,
    minWidth: 860,
    minHeight: 560,
    backgroundColor: '#141414',
    icon,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const trustedFileUrl = pathToFileURL(path.join(__dirname, '../renderer/index.html')).href;
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererUrl(url, rendererUrl, trustedFileUrl)) event.preventDefault();
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  if (rendererUrl) await mainWindow.loadURL(rendererUrl);
  else await mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  Menu.setApplicationMenu(null);
  app.whenReady().then(createWindow).catch(() => {
    const language: Language = app.getLocale().toLowerCase().startsWith('ru') ? 'ru' : 'en';
    dialog.showErrorBox(DIALOG_COPY[language].appName, DIALOG_COPY[language].startupError);
    app.quit();
  });
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
}
