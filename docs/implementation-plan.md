# PEPPERED Save Manager implementation plan

## Goal

Deliver a Windows-only, bilingual RU/EN desktop GUI that manages PEPPERED's single Easy Save 3 `Save.es3` as a safe named snapshot catalog, renders short human-readable checkpoint descriptions, and imports/exports the full catalog.

## Confirmed game contract

- Save file name: `Save.es3`.
- Unity persistent path on Windows: `%USERPROFILE%\\AppData\\LocalLow\\Mostly Games\\PEPPERED\\Save.es3`.
- Format: Easy Save 3 JSON, pretty printed, no compression, no encryption.
- Relevant keys: `LvlName`, `Pos`, `DeathCount`, `Chapter`, `Regret`, `Abyss_State`, `Choices`, `TheStuff`, `Stars`, `Coins`, `Green Gem`, `Enemies`, `Track`, `Volume`.
- Restoring only an arbitrary scene is unsafe because scene, position, and progression dictionaries form one state. V1 restores only captured saves.

## Stack

- Electron + React + TypeScript + Vite through electron-vite.
- Secure preload IPC: context isolation, sandbox, no renderer Node access.
- electron-builder Windows x64 portable executable.
- Vitest for core and renderer logic.
- JSZip for bounded validated catalog archives.

## Storage

`app.getPath("userData")/catalog-v1/`

- `settings.json`: schema version, selected language, save path override, text scale.
- `snapshots/<uuid>/save.es3`: opaque original save bytes.
- `snapshots/<uuid>/meta.json`: versioned metadata, title, capture time, source, SHA-256, parsed checkpoint summary.

Writes use temporary siblings plus atomic rename. Restore first captures the active save as a timestamped safety snapshot unless the active file is byte-identical to the selected snapshot.

## Tasks

1. Bootstrap the secure Electron/React/TypeScript application and design tokens.
2. Implement ES3 JSON metadata parsing with fail-soft human descriptions and tests.
3. Implement catalog repository, path discovery, capture, rename, delete, restore, dedupe, and settings.
4. Implement bounded export/import archive with schema, path, size, and hash validation plus merge summary.
5. Implement RU/EN typed i18n and the list/detail GUI with accessibility states.
6. Package a Windows x64 portable build.
7. Run unit tests, typecheck, production build, archive inspection, Wine launch smoke, and visual QA.
8. Run independent spec and quality reviews, fix all critical/important findings, then repeat decisive gates.

## Acceptance criteria

- Fresh launch explains how to locate the save if auto-discovery fails.
- Capturing a valid save produces a named snapshot and human checkpoint description.
- Restoring creates an automatic recovery copy and atomically replaces the active save.
- The app refuses malformed saves and unsafe/malformed catalog archives without damaging existing data.
- Catalog export round-trips through import without losing names, metadata, or save bytes.
- Switching RU/EN updates every visible control and persists.
- Core actions are keyboard reachable with visible focus and screen-reader labels.
- Windows portable artifact is produced and starts under Wine far enough to create a window without immediate runtime failure.
