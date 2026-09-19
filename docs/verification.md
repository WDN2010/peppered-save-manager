# Verification receipt

Verified on `2026-09-19T15:01:37+03:00` from `/home/wdn2010/peppered-save-manager`.

## Automated gates

- `npm test` — PASS: 4 test files, 23 tests.
- `npm run typecheck` — PASS.
- `npm run lint` — PASS with zero warnings.
- `npm run test:electron` — PASS: `ELECTRON_SMOKE_PASS bridge=object shell=true title=PEPPERED Save Manager lang=ru`.
  - The smoke test builds the production bundles, launches Electron 44.4.1 with an isolated home and user-data directory under Xvfb, connects over CDP, verifies the sandboxed CommonJS preload exposed `window.peppered`, and waits for the real app shell.
- `npm audit` — PASS: 0 vulnerabilities.
- `npm run dist:win` — PASS: Windows x64 portable target built with Electron 44.4.1 and electron-builder 26.15.3.
- `git diff --check` — PASS before commit.

## Artifact

- Path: `release/PEPPERED-Save-Manager-1.0.0-portable.exe`
- Size: `99,875,152` bytes
- SHA-256: `dafaa861c388641e98dbcd537483a8490e72d4072157fe23bf1190dd657ba767`
- Outer portable wrapper: PE32 NSIS self-extracting executable.
- Bundled application: PE32+ Windows x86-64 executable.
- Package inspection confirmed `out/preload/index.cjs`, renderer assets, and the custom four-size `build/icon.ico` are present in `app.asar`.

## Restore replacement primitive

Restore writes a uniquely named sibling temporary file with exclusive creation, writes the complete selected save bytes, calls `fsync`, closes the handle, and revalidates the target directory and file identity. It then performs exactly one same-directory `fs.rename(temp, Save.es3)` operation. Node/libuv maps the Windows implementation to `MoveFileExW` with `MOVEFILE_REPLACE_EXISTING`; the live file is never renamed away first, so failed replacement attempts leave it in place. Transient `EPERM`, `EACCES`, and `EBUSY` errors use bounded exponential retry. If replacement still fails, the complete temporary recovery file is preserved and its path is surfaced.

## Import/export and parser probes

Regression tests cover:

- fatal invalid UTF-8 rejection and meaningful PEPPERED ES3 shape validation;
- actual `__type` / `value` wrappers and corrected PEPPERED field types;
- concurrent same-byte capture deduplication;
- distinct automatic recovery snapshots;
- failed replacement preserving the original save and temporary evidence;
- symlink target and parent rejection;
- corrupt local metadata quarantine;
- path traversal, uppercase UUID/hash canonicalization, pre-decompression total-size rejection, mixed valid/invalid all-or-nothing import, and rollback after injected commit failure;
- sandbox-compatible preload output, CSP/navigation/IPC boundaries, semantic list buttons, scalable typography, custom icon packaging, and single-instance admission.

## Visual QA

Screenshots were inspected for:

- Russian empty state at 1120×720 / 100%;
- 130% scale at 1120×720;
- responsive 860×560 minimum window at 130% after layout reflow;
- populated checkpoint detail view with the name `A_7 — перед лифтом`.

The final layouts kept all controls reachable, switched to a vertically scrollable single-column layout at minimum width, preserved visible focus/selection hierarchy, and showed localized labels and human-readable checkpoint data. Primary button fill was darkened after contrast calculation so normal-size near-white text exceeds the 4.5:1 target.

## Runtime limitation

A real Windows host was not available in this environment. The portable NSIS wrapper and unpacked Electron executable did not yield a conclusive Wine smoke result (`wine_exit=2` and `wine_exit=3`; Wine reported experimental WoW64 / network-change and crashpad errors). This is recorded as an environment limitation, not as a successful Windows runtime test. The production Linux Electron launch is the verified preload/IPC/renderer smoke; a final native Windows launch remains recommended before public distribution.
