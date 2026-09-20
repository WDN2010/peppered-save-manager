# Verification receipt

Verified on `2026-09-20T21:10:06+03:00` for the version 1.0.6 public release candidate.

## Automated gates

- `npm test` — PASS on Linux and native Windows: 8 test files, 67 tests.
- `npx vitest run tests/catalog.test.ts tests/validation.test.ts` — PASS: 2 test files, 34 tests, including rolling recovery, safe Windows path aliases, exact BigInt filesystem identity, device-namespace rejection, junction rejection, and replacement evidence.
- `npm run typecheck` — PASS on Linux and native Windows.
- `npm run lint` — PASS with zero warnings on Linux and native Windows.
- `npm run test:electron` — PASS on Linux: `ELECTRON_SMOKE_PASS bridge=object shell=true launch=true capture=true inlineError=true title=PEPPERED Save Manager lang=ru`.
  - The smoke builds production bundles, launches Electron 44.4.1 with isolated home and user-data directories under Xvfb, connects over CDP, verifies the sandboxed CommonJS preload, captures a fixture through the prefilled dialog, and proves that a rejected capture remains visible inside the open dialog.
- `npm audit` — PASS: 0 vulnerabilities.
- `npm run test:windows-helper` — PASS on native Windows: `WINDOWS_REPLACE_SMOKE_PASS existing=true absent=true changed=true busy=true`.
- `npm run test:windows-save-lock` — PASS on native Windows: `WINDOWS_SAVE_LOCK_SMOKE_PASS transient=detected persistent=busy liveCapture=true noSnapshot=true inlineBusyRu=true`.
- `npm run dist:win` — PASS on native Windows: Windows x64 portable target built with Electron 44.4.1 and electron-builder 26.15.3.
- `git diff --check` — PASS before each release commit.

The authoritative CI receipt is [GitHub Actions run 35527674470](https://github.com/WDN2010/peppered-save-manager/actions/runs/35527674470), built from source commit `1dd4508d43916c62664e78834e4e5908a18467bf`. Both `Linux checks` and `Windows native safety checks` completed successfully.

## Release artifact

- Path: `release/PEPPERED-Save-Manager-1.0.6-portable.exe`
- Size: `100,518,018` bytes
- SHA-256: `5f35fb0f7c7c8cd002e0e69612da8d585ccdbb8d6c52aa6e42b4aca049b3ca8a`
- ZIP path: `release/PEPPERED-Save-Manager-1.0.6-portable.zip`
- ZIP size: `100,511,269` bytes
- ZIP SHA-256: `21416b6e7edc6e28b76b1f525649389053e1d7def64f870ee15d341f31b50f81`
- Outer portable wrapper: PE32 NSIS self-extracting executable.
- Bundled application: PE32+ Windows x86-64 executable.
- Authenticode security directory: absent; this community build is unsigned.
- ZIP verification: `unzip -t`, embedded checksum validation, and byte comparison against the downloaded native-Windows CI artifact all passed.

Package inspection confirmed version `1.0.6`, `out/main/index.js`, `out/preload/index.cjs`, renderer assets, and the custom four-size Merdeka portrait `build/icon.ico` in `app.asar`. The packaged icon matches the tracked ICO byte-for-byte at SHA-256 `26e88a967fdee1b6a7e4ac2d5dbe691009fee0ad6b60fbb6075a667a63301ad7`.

The native-Windows checkout uses CRLF text files. After CRLF→LF normalization, these packaged resources match their tracked sources:

- `resources/helpers/replace-save.ps1`: packaged raw SHA-256 `f170e8906e9f2616b36e82d14fe199dfda752f16b5c0afe470e6aca32f2952c7`; normalized/source SHA-256 `d89f41c45f045154a3207e39f65cb82b60774722cc92d3eb05439cd4837b0f3c`.
- `resources/LICENSE.peppered-save-manager.txt`: packaged raw SHA-256 `635afd0f4eae1545ffe1334e894e048269486c81ef940618a2fa8b71ec2ae4dc`; normalized/source SHA-256 `88b1b62e17a20ea3713a0577641df9eb822c3664e6bd63f7db1d30cccedd40ea`.
- `resources/NOTICE.peppered-save-manager.md`: packaged raw SHA-256 `cece012847a88fd896c1516c1019b8472289c5ae9f370b6c5b808e63b431c441`; normalized/source SHA-256 `29a68f42c6fdd1e2a13886ebc4f6fc93be79977fa40dc1ba598996873a700bff`.

## Restore replacement primitive

Restore writes a uniquely named sibling temporary file with exclusive creation, writes the complete selected save bytes, calls `fsync`, closes the handle, and revalidates the target directory and file identity. Security-sensitive identity comparisons use exact BigInt `dev`/`ino` values. Every existing path component is inspected for symlinks/junctions; benign Windows 8.3 or case aliases are accepted only when `realpath` identifies the exact same filesystem object. Windows device namespaces (`\\?\\`, `\\.\\`, and slash variants) are rejected explicitly.

On Windows, the packaged `helpers/replace-save.ps1` compiles a C# guard that opens and byte-locks the active save and replacement without write sharing and verifies their exact SHA-256 values. Because `ReplaceFileW` requires exclusive reopen, those handles are then closed and the existing target is replaced with a randomized same-directory backup in one operation. The helper immediately reopens and verifies both committed and backup hashes; a mismatch triggers rollback with the selected bytes restored to the temporary path. A rollback failure is terminal and is never retried: the UI reports uncertain active-save state and the actual guarded-backup path instead of claiming a consumed temporary file still exists. An absent target uses non-overwriting `MoveFileExW`, so an unexpectedly appeared target fails closed. The live filename never has a delete-then-create gap. Sharing violations use bounded exponential retry; failures preserve only verified recovery evidence and surface its path to the localized UI.

## Import/export and parser probes

Regression tests cover:

- fatal invalid UTF-8 rejection and meaningful PEPPERED ES3 shape validation;
- actual `__type` / `value` wrappers and corrected PEPPERED field types;
- concurrent same-byte capture deduplication, symlink-source rejection, stable-source reads, and benign Windows alias acceptance with exact identity;
- bounded retry of positively identified transient Windows sharing-lock failures, preservation of ordinary EACCES/EPERM permission errors, source-change errors after retry exhaustion, and the persistent busy contract;
- stable recovery reads, a fresh-candidate rolling automatic recovery snapshot (including overwrite, legacy convergence, renamed recovery, absent/identical no-ops, replacement-failure preservation, and post-replace cleanup failure coverage), and explicit absent/identical/different prior-state results;
- strict five-field `tasklist /FO CSV /NH` parsing, exact game-image matching, Save Manager self-match rejection, and fail-closed malformed/empty/process-error handling shared by Restore and Restore + launch;
- prefilled human-readable capture titles, enabled first-click capture, and inline modal errors for failed actions;
- changed-current-save detection, exact guarded Windows hash handoff, post-commit committed/backup hash verification with rollback assertions, quarantined candidate cleanup, and failed replacement preserving the original save with only existing temporary or guarded-backup evidence reported;
- symlink/junction target and parent rejection, exact BigInt identity mismatch rejection, and Windows device-namespace rejection while retaining ordinary drive and UNC paths;
- corrupt local metadata quarantine;
- path traversal, duplicate central-directory and unreferenced file/directory rejection, uppercase UUID/hash canonicalization, pre-decompression total-size rejection, same-kind hash deduplication with manual/recovery identical-byte preservation, conflicting duplicate-ID rejection, mixed valid/invalid all-or-nothing import, and rollback after injected commit failure;
- serialized settings repair versus concurrent updates;
- sandbox-compatible preload output, CSP/navigation/IPC boundaries, fixed Steam launch bridge, localized temporary/quarantine/guarded-backup restore failures, restore-error state refresh, semantic list buttons, scalable typography, custom icon packaging, and single-instance admission.

## Packaging environment

The accepted portable artifact is the artifact uploaded by the successful native-Windows GitHub Actions job. It was downloaded through the GitHub API, hashed locally, unpacked through the NSIS `app-64.7z` payload, and inspected independently. The locally cross-built Linux artifact was not used for the public release.

## Visual QA

Screenshots were inspected for:

- Russian empty state at 1120×720 / 100%;
- 130% scale at 1120×720;
- responsive 860×560 minimum window at 130% with a single page scroll and no nested detail scrollbar;
- populated checkpoint detail view with the name `A_7 — перед лифтом`;
- capture dialog with the generated `A_7 — Elevator area` title and enabled confirmation;
- capture rejection displayed as a readable inline alert without clipping actions;
- Merdeka portrait icon at its embedded 16×16, 32×32, 48×48, and 256×256 frames, including transparent corners, crop, border consistency, and small-size recognition.

The final layouts kept all controls reachable, switched to a vertically scrollable single-column layout at minimum width, preserved visible focus/selection hierarchy, and showed localized labels and human-readable checkpoint data. Primary button fill was darkened after contrast calculation so normal-size near-white text exceeds the 4.5:1 target.

## Remaining limitation

The rolling Recovery Copy behavior was manually accepted on Windows before publication. The final source revision additionally passed native Windows unit, guarded replacement, exclusive lock, and packaging gates in GitHub Actions. The exact final CI-produced portable EXE was not separately launched on a clean interactive Windows desktop after download; Windows SmartScreen may warn because the executable is unsigned.
