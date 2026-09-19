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

- Capture rejects symlinked or changing source files, validates UTF-8 JSON and the supported PEPPERED Easy Save 3 shape, then copies the stable original bytes exactly.
- Each snapshot stores a SHA-256 digest, capture time, source path, title, and a small parsed summary.
- Restore verifies the snapshot hash, refuses an invalid target, and refuses to proceed when the Windows process check cannot establish that PEPPERED is closed.
- Before replacement, a different current save always becomes a distinct automatic **Recovery copy** in the catalog, even when the same bytes also exist as a manual snapshot. Recovery labels are localized in the UI; renaming one makes it manual.
- Replacement writes a sibling temporary file, flushes it with `fsync`, and closes it. On Windows a packaged PowerShell/C# helper opens and locks the parent, active save, and replacement; verifies the exact recovery-time and replacement SHA-256 values while the no-write locks are held; and commits with one `ReplaceFileW` call. If another process already has a writable handle, changes the bytes, or creates a previously absent target, restore fails closed instead of overwriting that state. The implementation never moves the live file aside. Sharing violations use bounded exponential retry; a failed replacement preserves the complete temporary recovery file and reports its path.
- The renderer has no Node.js access. Electron 44.4.1 uses context isolation, a sandboxed CommonJS preload, `nodeIntegration: false`, strict CSP, loopback-only development loading, trusted-frame IPC checks, navigation blocking, and denied popups.

### Export and import

**Export catalog** creates a `.peppered-saves` ZIP archive containing a versioned manifest, exact `save.es3` bytes, complete validated metadata, and display settings (language and scale). Export is written through a flushed temporary file and one rename. Import is a merge transaction: it pre-sums declared save bytes before decompression, validates every entry and complete metadata shape before writing, rejects the whole batch when any entry is invalid, and rolls back every newly-added ID if commit or imported settings fails. Existing snapshots are never overwritten, the active save path is never imported, and successful imports round-trip language and scale. Limits are 64 MiB compressed archive size, 16 MiB per save, 48 MiB total save bytes, 1,000 snapshots, and 256 KiB metadata entries.

### Development

```text
npm ci
npm run dev       # electron-vite development app
npm run typecheck
npm run lint
npm test
npm run build
npm run test:electron # production preload/IPC/renderer smoke
npm audit
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

- При копировании отклоняются симлинки и изменяющийся во время чтения источник, затем проверяются UTF-8 JSON и поддерживаемая структура Easy Save 3, а стабильные исходные байты копируются без изменений.
- Для каждой точки хранятся SHA-256, время, путь источника, название и краткое описание состояния.
- Перед восстановлением проверяется хеш точки и корректность цели. На Windows действие закрывается, если нельзя подтвердить, что PEPPERED завершён.
- Отличающееся текущее сохранение всегда попадает в отдельную автоматическую **копию для восстановления**, даже если такие байты уже есть в обычной точке. Название копии локализуется в интерфейсе; переименование делает её обычной точкой.
- Запись выполняется через временный файл рядом с целью: `fsync` и закрытие. В Windows упакованный PowerShell/C# helper блокирует родительскую папку, активный save и замену от записи, под блокировкой сверяет точные SHA-256 текущего и нового файла и фиксирует замену одним вызовом `ReplaceFileW`. Если другой процесс уже держит writable handle, изменил байты или создал отсутствовавшую цель, восстановление завершается без перезаписи. Живой файл никогда не переносится в сторону; sharing violation повторяется с ограниченным backoff, а при ошибке полный временный файл сохраняется и его путь сообщается.
- Renderer не имеет доступа к Node.js: Electron 44.4.1 использует context isolation, sandboxed CommonJS preload, `nodeIntegration: false`, строгий CSP, загрузку разработки только с loopback, проверку доверенного IPC-кадра, блокировку навигации и запрет popup.

### Экспорт и импорт

**Экспорт каталога** создаёт ZIP `.peppered-saves` с версионированным манифестом, точными байтами `save.es3`, полной проверенной метаинформацией и настройками языка/масштаба. Архив записывается через временный файл с `fsync` и одним переименованием. Импорт — транзакция объединения: размер байтов сохранений суммируется до распаковки, все записи и метаданные проверяются до записи, при одной ошибке отклоняется весь пакет, а при сбое фиксации удаляются все новые ID. Существующие точки не заменяются, активный путь не импортируется, успешный импорт переносит язык и масштаб. Ограничения: 64 МиБ сжатого архива, 16 МиБ на сохранение, 48 МиБ суммарно, 1 000 точек и 256 КиБ на метаданные.

### Разработка

```text
npm ci
npm run dev
npm run typecheck
npm run lint
npm test
npm run build
npm run test:electron
npm audit
npm run dist:win
```

Ядро находится в `src/core` и тестируется с внедряемым корнем каталога без Electron. Демонстрационные файлы есть только в `tests/fixtures`.

### Текущие ограничения

- Поддерживается только Windows. Linux используется здесь для сборки, а не как целевая среда запуска.
- Проверка процесса восстановления использует `tasklist.exe`; при ошибке проверка закрывает действие.
- В первой версии восстанавливаются только полностью сохранённые точки. Произвольные сцены, прогресс, запуск игры и зашифрованные варианты Easy Save не редактируются.
- Для архивов действуют ограничения: 64 МиБ на архив, 16 МиБ на сохранение и 48 МиБ на все сохранения.
