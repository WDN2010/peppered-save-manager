import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Cdp, launchElectron, terminateChild, waitForPage, waitForValue } from './electron-smoke-helpers.mjs';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const port = 19637;
const home = await mkdtemp(path.join(os.tmpdir(), 'peppered-electron-smoke-'));
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
const { child, getLogs } = launchElectron({ root, env, port, userData });

let cdp;
let failure;
try {
  const page = await waitForPage(child, port);
  cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.command('Runtime.enable');
  await waitForValue(cdp, 'typeof window.peppered', 'object');
  await waitForValue(cdp, 'typeof window.peppered.restoreAndLaunch', 'function');
  await waitForValue(cdp, 'Boolean(document.querySelector(".app-shell")) && !document.body.innerText.includes("Loading catalog")', true);
  await waitForValue(cdp, 'document.querySelector(".live-strip")?.classList.contains("live-detected")', true);
  await cdp.evaluate('document.querySelector(".live-actions .button-primary").click()');
  await waitForValue(cdp, 'Boolean(document.querySelector("dialog[open] input"))', true);
  const captureReady = await cdp.evaluate('({ value: document.querySelector("dialog input").value, disabled: document.querySelector("dialog button[type=submit]").disabled })');
  if (!captureReady.value.trim() || captureReady.disabled) throw new Error('Capture dialog has no usable default title');
  await cdp.evaluate('document.querySelector("dialog button[type=submit]").click()');
  await waitForValue(cdp, '!document.querySelector("dialog") && document.querySelectorAll(".snapshot-row").length === 1', true);
  await writeFile(liveSave, '{"unsupported":true}', 'utf8');
  await cdp.evaluate('document.querySelector(".live-actions .button-primary").click()');
  await waitForValue(cdp, 'Boolean(document.querySelector("dialog[open] button[type=submit]"))', true);
  await cdp.evaluate('document.querySelector("dialog button[type=submit]").click()');
  await waitForValue(cdp, 'Boolean(document.querySelector("dialog[open] .dialog-error[role=alert]")?.textContent.trim())', true);
  const state = await cdp.evaluate('({ title: document.title, lang: document.documentElement.lang, shell: Boolean(document.querySelector(".app-shell")), launch: typeof window.peppered.restoreAndLaunch === "function" })');
  console.log(`ELECTRON_SMOKE_PASS bridge=object shell=true launch=${state.launch} capture=true inlineError=true title=${state.title} lang=${state.lang}`);
} catch (error) {
  failure = error;
  console.error(`ELECTRON_SMOKE_FAIL ${error instanceof Error ? error.message : String(error)}`);
  if (getLogs()) console.error(getLogs().slice(-4000));
} finally {
  cdp?.close();
  await terminateChild(child);
  await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
if (failure) process.exitCode = 1;
