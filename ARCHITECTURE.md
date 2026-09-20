# Architecture

PEPPERED Save Manager is a Windows-only Electron application that manages
complete PEPPERED `Save.es3` snapshots. It treats the game save as an opaque
file for storage and replacement while parsing a bounded subset of its JSON
metadata for display.

## Process boundaries

- **Renderer (`src/renderer`)** — React UI. It has no Node.js access.
- **Preload (`src/preload`)** — sandboxed CommonJS bridge exposing the typed,
  narrow API declared in `src/shared/ipc.ts`.
- **Main process (`src/main`)** — owns filesystem dialogs, Steam launch,
  process admission, and repository operations. IPC calls are accepted only
  from the trusted application frame.
- **Core (`src/core`)** — save validation, catalog storage, stable reads,
  archive import/export, Windows process parsing, and atomic replacement.
  Core modules receive explicit roots and are testable without Electron.

## Data flow

### Capture

1. Resolve and validate an absolute `Save.es3` path.
2. Reject symlinked/non-regular paths and unstable reads.
3. Retry only positively identified transient sharing locks or changing-save
   races with bounded backoff.
4. Validate the supported Easy Save 3 JSON shape and compute SHA-256.
5. Write exact source bytes and validated metadata into a new snapshot
   directory through temporary siblings and atomic rename.

### Restore

1. Verify the selected snapshot and active target.
2. On Windows, fail closed unless exact `tasklist /FO CSV /NH` parsing proves
   both game executable names are absent.
3. If the live save differs, publish a fresh valid automatic Recovery Copy.
4. Perform guarded replacement. The Windows helper verifies target and
   replacement hashes, uses `ReplaceFileW`/`MoveFileExW`, and verifies committed
   and backup hashes after replacement.
5. Only after clean replacement, remove older automatic recovery entries.
   Manual snapshots are never removed by rolling-recovery convergence.
6. Refresh renderer state after any restore error because a partial-success
   cleanup error can still follow a committed active-save replacement.

A clean differing restore leaves one automatic Recovery Copy containing the
immediately previous stable live bytes. Identical or absent-target restores do
not update it. See `docs/verification.md` for failure and evidence semantics.

## Storage

Electron's `userData` directory contains:

```text
catalog-v1/
  settings.json
  snapshots/<uuid>/save.es3
  snapshots/<uuid>/meta.json
```

This runtime state is private and must never be committed. Catalog exports are
bounded `.peppered-saves` ZIP files with a canonical manifest, validated paths,
per-save hashes, metadata, and display settings. Import is all-or-nothing for
invalid batches; hash deduplication is scoped by snapshot kind so a manual
snapshot and rolling recovery with identical bytes remain distinct.

## Trust boundaries

- Renderer content is untrusted relative to the filesystem and receives only
  typed preload methods.
- User-selected files and imported archives are untrusted and validated before
  mutation.
- The active save may be changed by PEPPERED or another process at any time;
  stable reads and guarded replacement detect bounded races and fail closed.
- Windows process output is untrusted CSV and is accepted only when every row
  is complete and valid.
- Steam launch uses the fixed PEPPERED App ID `1883370`.

## Source and generated boundaries

Tracked source includes the reproducible icon inputs and generated ICO/SVG
because packaging consumes `build/icon.ico`. `scripts/make-icon.py` regenerates
those outputs without third-party Python packages. The icon artwork is excluded
from the MIT License; see `NOTICE.md`.

The following are generated and ignored:

- `node_modules/`
- `out/`
- `release/`
- coverage and local environment files

Release executables belong in GitHub Releases, not Git history.

## Verification boundaries

Linux CI and local development cover unit tests, type checking, lint, builds,
and the production Electron preload/IPC/renderer smoke. Native Windows is
required for real sharing-lock semantics, guarded replacement smoke, and final
portable application acceptance.
