# Contributing

Thanks for helping improve PEPPERED Save Manager. This is a small fan-made
practice utility, so focused fixes with explicit failure behavior are preferred
over broad feature additions.

## Development setup

Requirements:

- Node.js 22 or newer;
- npm;
- Windows 10/11 x64 for native replacement and sharing-lock verification.

```text
npm ci
npm run dev
```

## Required checks

Run before opening a pull request:

```text
npm test
npm run typecheck
npm run lint
npm run build
npm run test:electron
npm audit
```

Changes to capture, restore, process detection, or the Windows helper must also
pass on native Windows:

```text
npm run test:windows-helper
npm run test:windows-save-lock
```

`npm run dist:win` builds the portable x64 executable.

## Safety expectations

- Add a regression test before changing save or catalog semantics.
- Preserve original `Save.es3` bytes; never silently rewrite game fields.
- Keep restore fail-closed when the running-game check or guarded replacement
  cannot establish a safe state.
- Keep renderer Node access disabled and IPC narrowly typed.
- Use synthetic fixtures only. Never commit or attach a real user save,
  catalog, AppData directory, token, log, or build output.
- Do not commit `node_modules/`, `out/`, or `release/`.

## Fan-tool and asset policy

PEPPERED and Merdeka are not licensed under this repository's MIT License. Do
not add new game artwork or other proprietary assets without discussing the
rights and distribution boundary first. See [`NOTICE.md`](NOTICE.md).

## Pull requests

Keep pull requests scoped. Describe:

- user-visible behavior;
- failure and rollback behavior;
- tests run, including whether native Windows gates were available;
- any change to stored data or archive compatibility.
