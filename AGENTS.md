# Repository guidance for coding agents

## Scope

This repository is the source of PEPPERED Save Manager. Runtime catalog data,
real game saves, and release outputs are outside the source boundary.

## Canonical checks

```text
npm ci
npm test
npm run typecheck
npm run lint
npm run build
npm run test:electron
npm audit
```

On native Windows also run:

```text
npm run test:windows-helper
npm run test:windows-save-lock
```

For release candidates run `npm run dist:win`, inspect `app.asar`, verify the
packaged helper and icon hashes, and publish the executable/checksum as release
assets rather than committing them.

## Safety rules

- Never commit real `Save.es3` files, AppData/catalog state, `.peppered-saves`
  archives, logs, credentials, `node_modules/`, `out/`, or `release/`.
- Test all filesystem mutations under temporary roots with synthetic fixtures.
- Treat capture/restore/import/export changes as data-safety changes: add a
  regression first and review failure/rollback paths explicitly.
- Preserve fail-closed Windows process detection and exact executable-name
  matching.
- Do not weaken Electron sandbox, context isolation, CSP, navigation blocking,
  or trusted-frame IPC checks.
- Keep EN/RU user-visible strings in the typed dictionaries.
- Do not add or replace game-derived artwork without updating the rights
  boundary in `NOTICE.md` and asking the maintainer when provenance is unclear.

## Intentional tracked generated assets

`build/icon.ico` and `build/icon.svg` are generated but tracked because release
packaging consumes them. Regenerate with:

```text
python3 -S scripts/make-icon.py
```

The source PNG and exact 16/32/48/256 frames are tracked for reproducibility.
They are excluded from the MIT License; see `NOTICE.md`.

## Documentation map

- `README.md` — user guide and project overview
- `ARCHITECTURE.md` — components, data flow, storage, and trust boundaries
- `CONTRIBUTING.md` — contributor workflow
- `SECURITY.md` — private vulnerability reporting
- `docs/verification.md` — latest release evidence and limitations
- `PRODUCT.md` / `DESIGN.md` — product and UI contracts
