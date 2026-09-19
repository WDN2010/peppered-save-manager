# Verification receipt

Verified on `2026-09-19T22:34:47+03:00` from `/home/wdn2010/peppered-save-manager`.

## Automated gates

- `npm test` — PASS: 4 test files, 31 tests.
- `npm run typecheck` — PASS.
- `npm run lint` — PASS with zero warnings.
- `npm run test:electron` — PASS: `ELECTRON_SMOKE_PASS bridge=object shell=true launch=true capture=true inlineError=true title=PEPPERED Save Manager lang=ru`.
  - The smoke test builds the production bundles, launches Electron 44.4.1 with an isolated home and user-data directory under Xvfb, connects over CDP, verifies the sandboxed CommonJS preload, captures a real fixture through the prefilled dialog, and proves a rejected capture remains visible inside the open dialog.
- `npm audit` — PASS: 0 vulnerabilities.
- `npm run dist:win` — PASS: Windows x64 portable target built with Electron 44.4.1 and electron-builder 26.15.3.
- `git diff --check` — PASS before commit.

## Artifact

- Path: `release/PEPPERED-Save-Manager-1.0.2-portable.exe`
- Size: `99,882,473` bytes
- SHA-256: `798080dc01fea2ae849ba145f1b69cefe45494b95a8a67020515221b42262802`
- Outer portable wrapper: PE32 NSIS self-extracting executable.
- Bundled application: PE32+ Windows x86-64 executable.
- Package inspection confirmed `out/preload/index.cjs`, renderer assets, and the custom four-size `build/icon.ico` are present in `app.asar`. The guarded Windows replacement helper is present at `resources/helpers/replace-save.ps1` with the same SHA-256 as its tracked source: `d89f41c45f045154a3207e39f65cb82b60774722cc92d3eb05439cd4837b0f3c`.

## Restore replacement primitive

Restore writes a uniquely named sibling temporary file with exclusive creation, writes the complete selected save bytes, calls `fsync`, closes the handle, and revalidates the target directory and file identity. On Windows, the packaged `helpers/replace-save.ps1` compiles a C# guard that opens and byte-locks the active save and replacement without write sharing and verifies their exact SHA-256 values. Because `ReplaceFileW` requires exclusive reopen, those handles are then closed and the existing target is replaced with a randomized same-directory backup in one operation. The helper immediately reopens and verifies both committed and backup hashes; any mismatch is rolled back with the selected bytes preserved again at the temporary path. An absent target uses non-overwriting `MoveFileExW`, so an unexpectedly appeared target fails closed. The live filename never has a delete-then-create gap. Sharing violations use bounded exponential retry; failures preserve recovery evidence and surface its path to the localized UI.

## Import/export and parser probes

Regression tests cover:

- fatal invalid UTF-8 rejection and meaningful PEPPERED ES3 shape validation;
- actual `__type` / `value` wrappers and corrected PEPPERED field types;
- concurrent same-byte capture deduplication, symlink-source rejection, and stable-source reads;
- bounded retry of transient Windows `EBUSY`/sharing-lock failures and a stable busy-file error after exhaustion;
- stable recovery reads, distinct automatic recovery snapshots, and explicit absent/identical/different prior-state results;
- prefilled human-readable capture titles, enabled first-click capture, and inline modal errors for failed actions;
- changed-current-save detection, exact guarded Windows hash handoff, and failed replacement preserving the original save and temporary evidence;
- symlink target and parent rejection;
- corrupt local metadata quarantine;
- path traversal, duplicate central-directory and unreferenced file/directory rejection, uppercase UUID/hash canonicalization, pre-decompression total-size rejection, mixed valid/invalid all-or-nothing import, and rollback after injected commit failure;
- serialized settings repair versus concurrent updates;
- sandbox-compatible preload output, CSP/navigation/IPC boundaries, the fixed Steam launch bridge, localized preserved-temporary-file failures, semantic list buttons, scalable typography, custom icon packaging, and single-instance admission.

The C# source embedded in the PowerShell helper was extracted and compiled successfully with Mono `mcs`. The compiled helper was then executed through Wine Mono against the current Win32 calls: existing-target replacement and absent-target creation passed; a changed target and a concurrently held writable handle both failed closed while preserving target and temporary bytes. A focused Windows-Node probe through the packaged Electron runtime also held `Save.es3` with an exclusive handle: a 350 ms lock was retried and captured successfully, while a persistent lock returned the stable user-facing `EBUSY` contract without writing a snapshot. `scripts/windows-replace-smoke.ps1` provides the equivalent native-Windows restore gate.

## Visual QA

Screenshots were inspected for:

- Russian empty state at 1120×720 / 100%;
- 130% scale at 1120×720;
- responsive 860×560 minimum window at 130% with a single page scroll and no nested detail scrollbar;
- populated checkpoint detail view with the name `A_7 — перед лифтом`;
- capture dialog with the generated `A_7 — Elevator area` title and enabled confirmation;
- capture rejection displayed as a readable inline alert without clipping actions.

The final layouts kept all controls reachable, switched to a vertically scrollable single-column layout at minimum width, preserved visible focus/selection hierarchy, and showed localized labels and human-readable checkpoint data. Primary button fill was darkened after contrast calculation so normal-size near-white text exceeds the 4.5:1 target.

## Runtime limitation

A real Windows host was not available in this environment. The focused helper did pass its Win32 calls through Wine Mono, but that is not a substitute for running `npm run test:windows-helper` on native Windows. The portable NSIS wrapper and unpacked Electron executable did not yield a conclusive full-app Wine smoke result (`wine_exit=2` and `wine_exit=3`; Wine reported experimental WoW64 / network-change and crashpad errors). The production Linux Electron launch is the verified preload/IPC/renderer smoke; a final native Windows launch remains recommended before public distribution.
