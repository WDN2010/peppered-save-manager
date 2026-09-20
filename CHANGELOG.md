# Changelog

All notable user-visible changes are recorded here.

## [1.0.6] — 2026-09-20

- Keep one rolling automatic Recovery Copy after a clean differing restore.
- Preserve manual and renamed recovery snapshots while converging legacy
  automatic duplicates.
- Make failed-replacement candidate cleanup quarantine-safe and refresh the UI
  after restore errors or partial-success cleanup failures.
- Preserve only verified temporary or guarded-backup evidence; Windows rollback
  uncertainty is terminal and never retried.
- Preserve identical manual and recovery bytes as distinct entries through
  catalog export/import.
- Add regression coverage for rolling recovery, archive identity, quarantine
  failures, localized evidence paths, and renderer refresh behavior.

## [1.0.5] — 2026-09-20

- Replace the generic application icon with a calmer Merdeka portrait icon.
- Add a reproducible standard-library-only icon build pipeline with exact
  16/32/48/256 pixel frames.

## [1.0.4] — 2026-09-20

- Stop `PEPPERED Save Manager.exe` from being mistaken for the running game.
- Parse complete `tasklist /FO CSV /NH` rows and match only exact PEPPERED game
  executable names.

## [1.0.3] — 2026-09-19

- Handle transient Windows save locks end to end with bounded retries and clear
  busy/permission feedback.
- Route live-state inspection and capture through stable save reads.
