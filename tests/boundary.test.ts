import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve('.');
const read = (file: string) => readFile(path.join(root, file), 'utf8');

describe('Electron and renderer release boundaries', () => {
  it('packages a sandbox-compatible CommonJS preload and points BrowserWindow at it', async () => {
    const config = await read('electron.vite.config.ts');
    const main = await read('src/main/index.ts');
    expect(config).toMatch(/format:\s*['"]cjs['"]/);
    expect(config).toMatch(/entryFileNames:\s*['"]\[name\]\.cjs['"]/);
    expect(main).toContain("preload: path.join(__dirname, '../preload/index.cjs')");
    expect(main).toContain('sandbox: true');
    expect(main).toContain('contextIsolation: true');
  });

  it('locks the trusted renderer boundary and denies navigation or popups', async () => {
    const main = await read('src/main/index.ts');
    expect(main).toContain('event.senderFrame.url');
    expect(main).toContain('setWindowOpenHandler(() => ({ action: \'deny\' }))');
    expect(main).toContain("mainWindow.webContents.on('will-navigate'");
    expect(main).toContain("if (rendererUrl) await mainWindow.loadURL(rendererUrl);");
    expect(main).toContain("else await mainWindow.loadFile");
    expect(main).toContain("Menu.setApplicationMenu(null)");
    expect(main).toContain('app.requestSingleInstanceLock()');
    expect(main).toContain("const PEPPERED_STEAM_URI = 'steam://rungameid/1883370'");
    expect(main).toContain("ipcMain.handle('app:restore-and-launch'");
    expect(main).toContain("import { verifyPepperedClosed } from '../core/windows-processes'");
    expect(main).toContain('await verifyGameClosed();');
    expect(main).toContain('return restoreCheckpoint(input.id);');
    expect(main).toContain('const restored = await restoreCheckpoint(input.id);');
    const preload = await read('src/preload/index.ts');
    expect(preload).toContain("ipcRenderer.invoke('app:restore-and-launch'");
    const catalog = await read('src/core/catalog.ts');
    expect(catalog).toContain('current = await readStableCaptureSource(targetPath)');
    expect(main).toContain("import { inspectLiveSave } from '../core/live'");
    expect(main).toContain('live: await inspectLiveSave(activePath)');
    expect(main).not.toContain('const readLive = async');
    expect(main).not.toContain('readFile(activePath)');
    const live = await read('src/renderer/components/LiveSaveStrip.tsx');
    expect(live).toContain("state.live.state === 'detected' || state.live.state === 'busy'");
    expect(live).toContain('disabled={busy || !captureAvailable}');
    const app = await read('src/renderer/App.tsx');
    expect(app).toContain("state.live.state !== 'detected' && state.live.state !== 'busy'");
    expect(app).toContain('savePermissionDenied');
    const ipc = await read('src/shared/ipc.ts');
    expect(ipc).toContain("'busy' | 'permission'");
    expect(app).toContain('restoreFailedWithTemp');
    expect(app).toContain("result.previousState === 'absent'");
  });

  it('uses a strict CSP, localized document language, scale-aware text, and semantic list buttons', async () => {
    const html = await read('src/renderer/index.html');
    const css = await read('src/renderer/styles.css');
    const app = await read('src/renderer/App.tsx');
    const list = await read('src/renderer/components/SnapshotList.tsx');
    expect(html).toContain("default-src 'self'");
    expect(html).toContain("object-src 'none'");
    expect(app).toContain('document.documentElement.lang = language');
    expect(css).toContain('--text-md: calc(13px * var(--ui-scale, 1))');
    expect(css).toContain('--subtle: oklch(0.82');
    expect(css).toContain('color: var(--ink); border-color: var(--primary-fill);');
    expect(list).toContain('<li key={snapshot.id}>');
    expect(list).not.toContain('role="listitem"');
  });

  it('keeps the native Windows lock smoke on the real renderer state path', async () => {
    const smoke = await read('scripts/windows-save-lock-smoke.mjs');
    expect(smoke).toContain('document.querySelector("#language-select")');
    expect(smoke).toContain('dispatchEvent(new Event("change", { bubbles: true }))');
    expect(smoke).not.toContain('window.peppered.setSettings({ language: "ru" })');
    expect(smoke).toContain('const state = await window.peppered.getState()');
    expect(smoke).toContain('transientState.elapsedMs < 500');
    expect(smoke).toContain('live-busy');
    expect(smoke).toContain('dialog-error[role=alert]');
  });

  it('pins Electron and ships the icon and guarded Windows replacement helper', async () => {
    const packageJson = JSON.parse(await read('package.json')) as {
      devDependencies: Record<string, string>;
      build: { files: string[]; extraResources: Array<{ from: string; to: string }>; win: { icon: string } };
    };
    expect(packageJson.devDependencies.electron).toBe('44.4.1');
    expect(packageJson.build.win.icon).toBe('build/icon.ico');
    expect(packageJson.build.files).toContain('build/icon.ico');
    expect(packageJson.build.extraResources).toContainEqual({ from: 'resources/replace-save.ps1', to: 'helpers/replace-save.ps1' });
    const icon = await readFile(path.join(root, 'build/icon.ico'));
    expect(icon.subarray(0, 6)).toEqual(Buffer.from([0, 0, 1, 0, 4, 0]));
    const helper = await read('resources/replace-save.ps1');
    expect(helper).toContain('LockFileEx');
    expect(helper).toContain('UnlockFileEx');
    expect(helper).toContain('ReplaceFileW');
    expect(helper).toContain('MoveFileExW');
    expect(helper).toContain('TARGET_CHANGED_DURING_RESTORE');
    expect(helper).toContain('ROLLBACK_FAILED_WIN32_');
    expect(helper).toContain('TARGET_CHANGED');
    expect(helper).not.toContain('GetDirectoryName(target).TrimEnd');
  });
});
