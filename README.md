# PEPPERED Save Manager

A focused, bilingual Windows desktop utility for capturing and restoring named PEPPERED practice checkpoints. The app treats the game's complete Easy Save 3 file as an opaque snapshot: it reads JSON metadata for display but never edits the game save.

## English

### Install and run

- Use Windows 10/11 x64.
- Install Node.js 22 or newer for development.
- `npm ci`
- `npm run dev`

The packaged application is portable and does not install a service, updater, telemetry, or network component.

### Save path

The default active save path is:

`%USERPROFILE%\\AppData\\LocalLow\\Mostly Games\\PEPPERED\\Save.es3`

If the file is not found, use **Choose save path**. The override is persisted in the app catalog under Electron's `userData` directory. Only a file named `Save.es3` can be selected as the active target.

### Safety model

- Capture validates UTF-8 JSON and the supported PEPPERED Easy Save 3 shape, then copies the original bytes exactly.
- Each snapshot stores a SHA-256 digest, capture time, source path, title, and a small parsed summary.
- Restore verifies the snapshot hash, refuses an invalid target, and refuses to proceed when the Windows process check cannot establish that PEPPERED is closed.
- Before replacement, a different current save becomes an automatic **Recovery copy** in the catalog.
- Replacement writes a sibling temporary file and uses a rename-based replacement with rollback handling for Windows' existing-file semantics.
- The renderer has no Node.js access. Electron uses context isolation, a sandboxed preload, `nodeIntegration: false`, and a narrow typed IPC API.

### Export and import

**Export catalog** creates a `.peppered-saves` ZIP archive containing a versioned manifest, exact `save.es3` bytes, metadata, and non-sensitive display settings. Import is a merge. It validates schema version, IDs, paths, hashes, JSON shape, entry count, archive size, and total save size. Existing snapshots are never overwritten. Malformed archive structure is rejected before catalog writes; duplicate IDs/content are reported as skipped or rejected.

### Development

```text
npm ci
npm run dev       # electron-vite development app
npm run typecheck
npm run lint
npm test
npm run build
npm run dist:win # Windows x64 portable EXE
```

Core modules live under `src/core` and take injected catalog roots, so they can be tested without Electron globals. The demo fixtures used by tests are under `tests/fixtures` only.

### Current limitations

- The product is Windows-only. The Linux host can build the portable artifact but is not the supported runtime.
- Restore checks running processes with `tasklist.exe`; if that check fails, restore is closed rather than guessed safe.
- V1 restores complete captured saves only. It does not synthesize arbitrary scenes, edit progress, launch the game, or inspect encrypted/compressed Easy Save variants.
- Catalog archives are bounded to 64 MiB compressed archive size, 16 MiB per save, and 48 MiB total save bytes.

## Русский

### Установка и запуск

- Используйте Windows 10/11 x64.
- Для разработки установите Node.js 22 или новее.
- Выполните `npm ci`, затем `npm run dev`.

Готовая версия переносимая: приложение не устанавливает службы, обновлятор, телеметрию и сетевые компоненты.

### Путь к сохранению

Путь по умолчанию:

`%USERPROFILE%\\AppData\\LocalLow\\Mostly Games\\PEPPERED\\Save.es3`

Если файл не найден, нажмите **Выбрать путь**. Переопределение сохраняется в каталоге приложения Electron. В качестве активной цели принимается только файл с именем `Save.es3`.

### Безопасность

- При копировании проверяются UTF-8 JSON и поддерживаемая структура Easy Save 3, после чего исходные байты копируются без изменений.
- Для каждой точки хранятся SHA-256, время, путь источника, название и краткое описание состояния.
- Перед восстановлением проверяется хеш точки и корректность цели. На Windows действие закрывается, если нельзя подтвердить, что PEPPERED завершён.
- Отличающееся текущее сохранение сначала попадает в каталог как автоматическая **Recovery copy**.
- Запись выполняется через временный файл рядом с целью и переименование с откатом при проблеме.
- Renderer не имеет доступа к Node.js: включены изоляция контекста и sandbox, а `nodeIntegration` отключён.

### Экспорт и импорт

**Экспорт каталога** создаёт ZIP-архив `.peppered-saves` с версионированным манифестом, точными байтами `save.es3`, метаданными и настройками отображения. Импорт объединяет каталоги, не заменяя существующие точки. Проверяются версия, идентификаторы, пути, хеши, структура JSON и ограничения размера. Повреждённый архив отклоняется до записи, а дубликаты отражаются в результате.

### Разработка

```text
npm ci
npm run dev
npm run typecheck
npm run lint
npm test
npm run build
npm run dist:win
```

Ядро находится в `src/core` и тестируется с внедряемым корнем каталога без Electron. Демонстрационные файлы есть только в `tests/fixtures`.

### Текущие ограничения

- Поддерживается только Windows. Linux используется здесь для сборки, а не как целевая среда запуска.
- Проверка процесса восстановления использует `tasklist.exe`; при ошибке проверка закрывает действие.
- В первой версии восстанавливаются только полностью сохранённые точки. Произвольные сцены, прогресс, запуск игры и зашифрованные варианты Easy Save не редактируются.
- Для архивов действуют ограничения: 64 МиБ на архив, 16 МиБ на сохранение и 48 МиБ на все сохранения.
