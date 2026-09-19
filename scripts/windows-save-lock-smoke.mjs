import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Cdp, launchElectron, terminateChild, waitForPage, waitForValue } from './electron-smoke-helpers.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = 19638;

function startExclusiveLock(filePath, durationMs) {
  const command = [
    '$ErrorActionPreference="Stop";',
    '$path=[Environment]::GetEnvironmentVariable("PEPPERED_LOCK_PATH");',
    '$duration=[int][Environment]::GetEnvironmentVariable("PEPPERED_LOCK_MS");',
    '$stream=[System.IO.File]::Open($path,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::None);',
    'Write-Output "LOCK_ACQUIRED";',
    'Start-Sleep -Milliseconds $duration;',
    '$stream.Dispose();',
  ].join(' ');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    cwd: root,
    env: { ...process.env, PEPPERED_LOCK_PATH: filePath, PEPPERED_LOCK_MS: String(durationMs) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let resolveAcquired;
  let rejectAcquired;
  const acquired = new Promise((resolve, reject) => { resolveAcquired = resolve; rejectAcquired = reject; });
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
    if (output.includes('LOCK_ACQUIRED')) resolveAcquired();
  });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  child.once('error', rejectAcquired);
  child.once('exit', (code) => {
    if (!output.includes('LOCK_ACQUIRED')) rejectAcquired(new Error(`PowerShell lock exited before acquiring handle: ${code}\n${output}`));
  });
  return { child, acquired, getOutput: () => output };
}

async function stopLock(lock) {
  await terminateChild(lock.child);
}

async function main() {
  if (process.platform !== 'win32') {
    console.error('WINDOWS_SAVE_LOCK_SMOKE_SKIP native Windows is required for exclusive Save.es3 sharing locks');
    process.exitCode = 2;
    return;
  }

  const home = await mkdtemp(path.join(os.tmpdir(), 'peppered-windows-lock-smoke-'));
  const userData = path.join(home, 'user-data');
  const liveSave = path.join(home, 'AppData', 'LocalLow', 'Mostly Games', 'PEPPERED', 'Save.es3');
  await mkdir(path.dirname(liveSave), { recursive: true });
  await copyFile(path.join(root, 'tests', 'fixtures', 'sample-save.es3'), liveSave);
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, 'config'),
    XDG_DATA_HOME: path.join(home, 'data'),
    XDG_CACHE_HOME: path.join(home, 'cache'),
  };
  let transientLock;
  let persistentLock;
  let cdp;
  let child;
  let failure;
  try {
    ({ child } = launchElectron({ root, env, port, userData }));
    const page = await waitForPage(child, port);
    cdp = new Cdp(page.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.command('Runtime.enable');
    await cdp.command('Page.enable');
    await waitForValue(cdp, 'typeof window.peppered', 'object');
    await waitForValue(cdp, 'Boolean(document.querySelector(".app-shell")) && !document.body.innerText.includes("Loading catalog")', true);
    await waitForValue(cdp, 'document.querySelector(".live-strip")?.classList.contains("live-detected")', true);

    transientLock = startExclusiveLock(liveSave, 700);
    await transientLock.acquired;
    const transientState = await cdp.evaluate('(async () => { const started = performance.now(); const state = await window.peppered.getState(); return { live: state.live.state, elapsedMs: performance.now() - started }; })()');
    if (transientState.live !== 'detected' || transientState.elapsedMs < 500) throw new Error(`Transient exclusive lock did not exercise bounded retry: ${JSON.stringify(transientState)}`);

    await cdp.evaluate('(() => { const select = document.querySelector("#language-select"); select.value = "ru"; select.dispatchEvent(new Event("change", { bubbles: true })); return true; })()');
    await waitForValue(cdp, 'document.documentElement.lang', 'ru');

    persistentLock = startExclusiveLock(liveSave, 15_000);
    await persistentLock.acquired;
    await cdp.command('Page.reload', { ignoreCache: true });
    await waitForValue(cdp, 'Boolean(document.querySelector(".app-shell")) && !document.body.innerText.includes("Loading catalog")', true);
    await waitForValue(cdp, 'document.querySelector(".live-strip")?.classList.contains("live-busy")', true);
    const busyState = await cdp.evaluate('({ lang: document.documentElement.lang, copy: document.querySelector(".live-copy p")?.textContent, disabled: document.querySelector(".live-actions .button-primary")?.disabled, snapshots: document.querySelectorAll(".snapshot-row").length })');
    if (busyState.lang !== 'ru' || busyState.disabled || busyState.snapshots !== 0 || !busyState.copy?.includes('удерживает')) throw new Error(`Persistent busy live state was not usable: ${JSON.stringify(busyState)}`);

    await cdp.evaluate('document.querySelector(".live-actions .button-primary").click()');
    await waitForValue(cdp, 'Boolean(document.querySelector("dialog[open] input"))', true);
    const titleBeforeEntry = await cdp.evaluate('document.querySelector("dialog input").value');
    if (titleBeforeEntry !== '') throw new Error(`Busy capture dialog unexpectedly supplied a title: ${titleBeforeEntry}`);
    await cdp.evaluate('document.querySelector("dialog input").focus()');
    await cdp.command('Input.insertText', { text: 'Заблокированная точка' });
    await waitForValue(cdp, 'document.querySelector("dialog input").value', 'Заблокированная точка');
    await cdp.evaluate('document.querySelector("dialog button[type=submit]").click()');
    await waitForValue(cdp, 'Boolean(document.querySelector("dialog[open] .dialog-error[role=alert]")?.textContent.includes("занят"))', true, 10_000);
    const finalState = await cdp.evaluate('({ error: document.querySelector("dialog[open] .dialog-error[role=alert]")?.textContent, snapshots: document.querySelectorAll(".snapshot-row").length })');
    if (finalState.snapshots !== 0) throw new Error(`Persistent lock created a snapshot: ${JSON.stringify(finalState)}`);
    console.log(`WINDOWS_SAVE_LOCK_SMOKE_PASS transient=detected persistent=busy liveCapture=true noSnapshot=true inlineBusyRu=true error=${JSON.stringify(finalState.error)}`);
  } catch (error) {
    failure = error;
    console.error(`WINDOWS_SAVE_LOCK_SMOKE_FAIL ${error instanceof Error ? error.message : String(error)}`);
    if (persistentLock) console.error(persistentLock.getOutput());
    else if (transientLock) console.error(transientLock.getOutput());
  } finally {
    cdp?.close();
    if (transientLock) await stopLock(transientLock);
    if (persistentLock) await stopLock(persistentLock);
    if (child) await terminateChild(child);
    await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
  if (failure) process.exitCode = 1;
}

await main();
