import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(new URL('..', import.meta.url).pathname);
const electron = require('electron');
const port = 19637;
const home = await mkdtemp(path.join(os.tmpdir(), 'peppered-electron-smoke-'));
const userData = path.join(home, 'user-data');
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: path.join(home, 'config'),
  XDG_DATA_HOME: path.join(home, 'data'),
  XDG_CACHE_HOME: path.join(home, 'cache'),
};
const electronArgs = [
  '--no-sandbox',
  '--disable-gpu',
  '--remote-debugging-address=127.0.0.1',
  `--remote-debugging-port=${port}`,
  '--remote-allow-origins=http://127.0.0.1:19637',
  `--user-data-dir=${userData}`,
  root,
];
const launchCommand = process.platform === 'linux' ? 'xvfb-run' : electron;
const launchArgs = process.platform === 'linux' ? ['-a', electron, ...electronArgs] : electronArgs;
const child = spawn(launchCommand, launchArgs, {
  cwd: root,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: process.platform !== 'win32',
});
let logs = '';
child.stdout.on('data', (chunk) => { logs += chunk.toString(); });
child.stderr.on('data', (chunk) => { logs += chunk.toString(); });

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function waitForPage(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Electron exited early with code ${child.exitCode}`);
    try {
      const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
      if (page) return page;
    } catch { /* Electron is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for Electron page target');
}

class Cdp {
  constructor(url) {
    this.nextId = 1;
    this.pending = new Map();
    this.socket = new WebSocket(url);
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    });
    this.socket.addEventListener('error', (event) => {
      for (const pending of this.pending.values()) pending.reject(new Error(`CDP socket error: ${event}`));
      this.pending.clear();
    });
    this.socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) pending.reject(new Error('CDP socket closed'));
      this.pending.clear();
    });
  }

  async open() {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
  }

  command(method, params = {}) {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  async evaluate(expression) {
    const result = await this.command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? 'Runtime evaluation failed');
    return result.result?.value;
  }

  close() { this.socket.close(); }
}

async function waitForValue(cdp, expression, expected, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cdp.evaluate(expression) === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${expression}`);
}

async function terminateChild() {
  if (child.exitCode !== null) return;
  const signal = (name) => {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, name);
      else child.kill(name);
    } catch { /* Already exited. */ }
  };
  signal('SIGTERM');
  const exited = await Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 2_000)),
  ]);
  if (!exited) signal('SIGKILL');
}

let cdp;
let failure;
try {
  const page = await waitForPage();
  cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.command('Runtime.enable');
  await waitForValue(cdp, 'typeof window.peppered', 'object');
  await waitForValue(cdp, 'Boolean(document.querySelector(".app-shell")) && !document.body.innerText.includes("Loading catalog")', true);
  const state = await cdp.evaluate('({ title: document.title, lang: document.documentElement.lang, shell: Boolean(document.querySelector(".app-shell")) })');
  console.log(`ELECTRON_SMOKE_PASS bridge=object shell=true title=${state.title} lang=${state.lang}`);
} catch (error) {
  failure = error;
  console.error(`ELECTRON_SMOKE_FAIL ${error instanceof Error ? error.message : String(error)}`);
  if (logs) console.error(logs.slice(-4000));
} finally {
  cdp?.close();
  await terminateChild();
  await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
if (failure) process.exitCode = 1;
