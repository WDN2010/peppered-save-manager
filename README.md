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

**Restore + launch** performs the same confirmed safe restore, then asks Steam to launch PEPPERED through its fixed App ID `1883370`. Plain **Restore checkpoint** never launches another process.

### Safety model

- Capture rejects symlinked or changing source files, validates UTF-8 JSON and the supported PEPPERED Easy Save 3 shape, then copies the stable original bytes exactly.
- Transient Windows sharing locks and in-progress saves are retried with bounded backoff; a persistent lock produces a specific inline “Save.es3 is busy” message instead of a generic failure.
- The capture dialog starts with a human-readable title from the detected scene, so **Capture checkpoint** works immediately; capture, restore, rename, and delete failures stay visible inside the open dialog.
- Each snapshot stores a SHA-256 digest, capture time, source path, title, and a small parsed summary.
- Restore verifies the snapshot hash, refuses an invalid target, and refuses to proceed when the Windows process check cannot establish that PEPPERED is closed.
- Before replacement, a different current save always becomes a distinct automatic **Recovery copy** in the catalog, even when the same bytes also exist as a manual snapshot. Recovery labels are localized in the UI; renaming one makes it manual.
- Replacement writes a sibling temporary file, flushes it with `fsync`, and closes it. On Windows a packaged PowerShell/C# helper opens and byte-locks the active save and replacement without write sharing, verifies their exact SHA-256 values, then closes those handles because `ReplaceFileW` requires exclusive reopen. The existing target is replaced with a randomized same-directory backup in one `ReplaceFileW` operation; both committed and backup hashes are immediately verified. A mismatch is rolled back with the selected bytes restored to the temporary path. An absent target uses non-overwriting `MoveFileExW`, so a concurrently appeared file fails closed. The implementation never creates a target-name gap. Sharing violations use bounded exponential retry; failed or rolled-back replacement preserves recovery evidence and reports its path.
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
npm run test:windows-helper # native Windows guarded-replace smoke
npm audit
npm run dist:win # Windows x64 portable EXE
```

Core modules live under `src/core` and take injected catalog roots, so they can be tested without Electron globals. The demo fixtures used by tests are under `tests/fixtures` only.

### Current limitations

- The product is Windows-only. The Linux host can build the portable artifact but is not the supported runtime.
- Restore checks running processes with `tasklist.exe`; if that check fails, restore is closed rather than guessed safe.
- V1 restores complete captured saves only. It does not synthesize arbitrary scenes, edit progress, launch a non-Steam executable, or inspect encrypted/compressed Easy Save variants.
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

**Восстановить + запустить** выполняет то же подтверждённое безопасное восстановление, а затем просит Steam запустить PEPPERED по фиксированному App ID `1883370`. Обычная кнопка **Восстановить точку** ничего не запускает.

### Безопасность

- При копировании отклоняются симлинки и изменяющийся во время чтения источник, затем проверяются UTF-8 JSON и поддерживаемая структура Easy Save 3, а стабильные исходные байты копируются без изменений.
- Временная Windows-блокировка файла и сохранение в процессе повторяются с ограниченным backoff; постоянная блокировка показывает точную inline-ошибку «Save.es3 занят», а не общий сбой.
- Диалог копирования сразу подставляет понятное название из распознанной сцены, поэтому **Сохранить точку** работает без обязательного ручного ввода; ошибки копирования, восстановления, переименования и удаления показываются внутри открытого диалога.
- Для каждой точки хранятся SHA-256, время, путь источника, название и краткое описание состояния.
- Перед восстановлением проверяется хеш точки и корректность цели. На Windows действие закрывается, если нельзя подтвердить, что PEPPERED завершён.
- Отличающееся текущее сохранение всегда попадает в отдельную автоматическую **копию для восстановления**, даже если такие байты уже есть в обычной точке. Название копии локализуется в интерфейсе; переименование делает её обычной точкой.
- Запись выполняется через временный файл рядом с целью: `fsync` и закрытие. В Windows упакованный PowerShell/C# helper открывает активный save и замену без write sharing, byte-lock'ом защищает точную проверку SHA-256, затем закрывает handles, потому что `ReplaceFileW` требует exclusive reopen. Существующая цель заменяется с randomized backup одним `ReplaceFileW`; сразу проверяются хеши результата и backup. При несовпадении выполняется rollback, а выбранные байты возвращаются во временный путь. Для отсутствующей цели используется `MoveFileExW` без перезаписи, поэтому внезапно появившийся файл приводит к отказу. Gap в имени цели не создаётся; sharing violation повторяется с ограниченным backoff, а при ошибке сохраняются recovery evidence и их путь сообщается.
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
npm run test:windows-helper
npm audit
npm run dist:win
```

Ядро находится в `src/core` и тестируется с внедряемым корнем каталога без Electron. Демонстрационные файлы есть только в `tests/fixtures`.

### Текущие ограничения

- Поддерживается только Windows. Linux используется здесь для сборки, а не как целевая среда запуска.
- Проверка процесса восстановления использует `tasklist.exe`; при ошибке проверка закрывает действие.
- В первой версии восстанавливаются только полностью сохранённые точки. Произвольные сцены, прогресс, запуск не-Steam версии и зашифрованные варианты Easy Save не поддерживаются.
- Для архивов действуют ограничения: 64 МиБ на архив, 16 МиБ на сохранение и 48 МиБ на все сохранения.
