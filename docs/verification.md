# Verification receipt

Verified on `2026-09-19T15:55:25+03:00` from `/home/wdn2010/peppered-save-manager`.

## Automated gates

- `npm test` — PASS: 4 test files, 27 tests.
- `npm run typecheck` — PASS.
- `npm run lint` — PASS with zero warnings.
- `npm run test:electron` — PASS: `ELECTRON_SMOKE_PASS bridge=object shell=true launch=true title=PEPPERED Save Manager lang=ru`.
  - The smoke test builds the production bundles, launches Electron 44.4.1 with an isolated home and user-data directory under Xvfb, connects over CDP, verifies the sandboxed CommonJS preload exposed `window.peppered`, and waits for the real app shell.
- `npm audit` — PASS: 0 vulnerabilities.
- `npm run dist:win` — PASS: Windows x64 portable target built with Electron 44.4.1 and electron-builder 26.15.3.
- `git diff --check` — PASS before commit.

## Artifact

- Path: `release/PEPPERED-Save-Manager-1.0.0-portable.exe`
- Size: `99,882,088` bytes
- SHA-256: `9b66b0df3a689b2727e086715235b41b8d02b2274b115115c07606903b7c069a`
- Outer portable wrapper: PE32 NSIS self-extracting executable.
- Bundled application: PE32+ Windows x86-64 executable.
- Package inspection confirmed `out/preload/index.cjs`, renderer assets, and the custom four-size `build/icon.ico` are present in `app.asar`. The guarded Windows replacement helper is present at `resources/helpers/replace-save.ps1` with the same SHA-256 as its tracked source: `d7af8721353c026f341bb9eb9737ad9732d7a2604c56641b33d8dd3848b32660`.

## Restore replacement primitive

Restore writes a uniquely named sibling temporary file with exclusive creation, writes the complete selected save bytes, calls `fsync`, closes the handle, and revalidates the target directory and file identity. On Windows, the packaged `helpers/replace-save.ps1` compiles a small C# guard that opens the parent without delete sharing, opens and locks the active save and replacement against writes, verifies the exact recovery-time and replacement SHA-256 values under those locks, and then performs one `ReplaceFileW` commit. A writable peer handle, changed bytes, or an unexpectedly appeared target fails closed. The live file is never renamed away first. Sharing violations use bounded exponential retry; if replacement still fails, the complete temporary recovery file is preserved and its path is surfaced.

## Import/export and parser probes

Regression tests cover:

- fatal invalid UTF-8 rejection and meaningful PEPPERED ES3 shape validation;
- actual `__type` / `value` wrappers and corrected PEPPERED field types;
- concurrent same-byte capture deduplication, symlink-source rejection, and stable-source reads;
- distinct automatic recovery snapshots;
- changed-current-save detection, exact guarded Windows hash handoff, and failed replacement preserving the original save and temporary evidence;
- symlink target and parent rejection;
- corrupt local metadata quarantine;
- path traversal, unreferenced ZIP entry rejection, uppercase UUID/hash canonicalization, pre-decompression total-size rejection, mixed valid/invalid all-or-nothing import, and rollback after injected commit failure;
- serialized settings repair versus concurrent updates;
- sandbox-compatible preload output, CSP/navigation/IPC boundaries, the fixed Steam launch bridge, semantic list buttons, scalable typography, custom icon packaging, and single-instance admission.

The C# source embedded in the PowerShell helper was also extracted and compiled successfully with Mono `mcs` as a syntax/type probe. Native Win32 calls themselves remain part of the native-Windows runtime gate below.

## Visual QA

Screenshots were inspected for:

- Russian empty state at 1120×720 / 100%;
- 130% scale at 1120×720;
- responsive 860×560 minimum window at 130% with a single page scroll and no nested detail scrollbar;
- populated checkpoint detail view with the name `A_7 — перед лифтом`.

The final layouts kept all controls reachable, switched to a vertically scrollable single-column layout at minimum width, preserved visible focus/selection hierarchy, and showed localized labels and human-readable checkpoint data. Primary button fill was darkened after contrast calculation so normal-size near-white text exceeds the 4.5:1 target.

## Runtime limitation

A real Windows host was not available in this environment. The portable NSIS wrapper and unpacked Electron executable did not yield a conclusive Wine smoke result (`wine_exit=2` and `wine_exit=3`; Wine reported experimental WoW64 / network-change and crashpad errors). This is recorded as an environment limitation, not as a successful Windows runtime test. The production Linux Electron launch is the verified preload/IPC/renderer smoke; a final native Windows launch remains recommended before public distribution.
