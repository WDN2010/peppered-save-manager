import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { AppState } from '../shared/ipc';
import type { Language, UiScale } from '../shared/types';
import { ActionModal } from './components/ActionModal';
import { DetailPane } from './components/DetailPane';
import { LiveSaveStrip } from './components/LiveSaveStrip';
import { SnapshotList } from './components/SnapshotList';
import { t, type CopyKey } from './i18n';

type ModalState =
  | { kind: 'capture'; value: string }
  | { kind: 'rename'; value: string; id: string }
  | { kind: 'restore'; id: string }
  | { kind: 'delete'; id: string }
  | null;

type StatusState = { key: CopyKey; vars?: Record<string, string | number> };

function friendlyErrorKey(error: unknown): CopyKey {
  const message = error instanceof Error ? error.message : '';
  if (/Close PEPPERED|закройте PEPPERED/i.test(message)) return 'closeGame';
  if (/not found|не найдено/i.test(message)) return 'notFound';
  if (/path|путь|Save\.es3/i.test(message)) return 'setPathFirst';
  return 'actionFailed';
}

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<'newest' | 'oldest' | 'title'>('newest');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState>(null);
  const [status, setStatus] = useState<StatusState | null>(null);
  const [busy, setBusy] = useState(false);
  const operationRef = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const next = await window.peppered.getState();
      setState(next);
      setLoadError(false);
      setSelectedId((current) => current && next.snapshots.some((snapshot) => snapshot.id === current) ? current : next.snapshots[0]?.id ?? null);
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const language = state?.settings.language ?? 'en';
  const startupLanguage: Language = navigator.language.toLowerCase().startsWith('ru') ? 'ru' : 'en';
  useEffect(() => {
    document.documentElement.lang = language;
    document.title = t(language, 'appName');
  }, [language]);

  const snapshots = useMemo(() => {
    if (!state) return [];
    const term = search.trim().toLocaleLowerCase(language === 'ru' ? 'ru-RU' : 'en-US');
    const displayTitle = (snapshot: AppState['snapshots'][number]) => snapshot.kind === 'recovery' ? t(language, 'recoveryTitle') : snapshot.title;
    const visible = state.snapshots.filter((snapshot) => !term || `${displayTitle(snapshot)} ${snapshot.summary.description.en} ${snapshot.summary.description.ru}`.toLocaleLowerCase().includes(term));
    return visible.sort((a, b) => sort === 'title' ? displayTitle(a).localeCompare(displayTitle(b), language) : sort === 'newest' ? b.capturedAt.localeCompare(a.capturedAt) : a.capturedAt.localeCompare(b.capturedAt));
  }, [state, search, sort, language]);
  const selected = state?.snapshots.find((snapshot) => snapshot.id === selectedId) ?? null;

  const runMutation = async (operation: () => Promise<void>, success?: StatusState) => {
    const token = ++operationRef.current;
    setBusy(true);
    setStatus({ key: 'working' });
    try {
      await operation();
      if (token === operationRef.current && success) setStatus(success);
    } catch (error) {
      if (token === operationRef.current) setStatus({ key: friendlyErrorKey(error) });
    } finally {
      if (token === operationRef.current) setBusy(false);
    }
  };

  const choosePath = () => void runMutation(async () => {
    const next = await window.peppered.chooseSavePath();
    if (next) setState(next);
  }, { key: 'ready' });

  const capture = () => void runMutation(async () => {
    if (!state || state.live.state !== 'detected' || !modal || modal.kind !== 'capture') {
      setStatus({ key: 'setPathFirst' });
      return;
    }
    const result = await window.peppered.capture(modal.value.trim());
    setState(result.state);
    setSelectedId(result.snapshot.id);
    setModal(null);
    setStatus({ key: result.kind === 'created' ? 'capturedStatus' : 'duplicateStatus' });
  });

  const rename = () => void runMutation(async () => {
    if (!modal || modal.kind !== 'rename') return;
    setState(await window.peppered.rename(modal.id, modal.value.trim()));
    setModal(null);
  }, { key: 'renamedStatus' });

  const remove = () => void runMutation(async () => {
    if (!modal || modal.kind !== 'delete') return;
    setState(await window.peppered.delete(modal.id));
    setModal(null);
  }, { key: 'deletedStatus' });

  const restore = () => void runMutation(async () => {
    if (!modal || modal.kind !== 'restore') return;
    const result = await window.peppered.restore(modal.id);
    setState(result.state);
    setModal(null);
    setStatus({ key: result.safetySnapshotId ? 'restoredStatus' : 'restoredNoBackupStatus' });
  });

  const exportCatalog = () => void runMutation(async () => {
    await window.peppered.exportCatalog();
  }, { key: 'exportedStatus' });

  const importCatalog = () => void runMutation(async () => {
    const result = await window.peppered.importCatalog();
    if (result.rejected > 0) {
      setStatus({ key: 'importedRejected', vars: { count: result.rejected } });
      return;
    }
    await refresh();
    setStatus({ key: 'importedSummary', vars: { added: result.added, skipped: result.skipped, rejected: result.rejected } });
  });

  const setLanguage = (value: Language) => void runMutation(async () => {
    setState(await window.peppered.setSettings({ language: value }));
  }, { key: 'ready' });
  const setScale = (value: UiScale) => void runMutation(async () => {
    setState(await window.peppered.setSettings({ scale: value }));
  }, { key: 'ready' });

  if (!state) {
    return <main className="loading-screen"><div className="brand-lockup"><span className="brand-mark" aria-hidden="true">P</span><div><strong>PEPPERED</strong><span className="loading-spinner" aria-hidden="true" /></div></div>{loadError && <button type="button" className="button button-primary" onClick={() => void refresh()}>{t(startupLanguage, 'retry')}</button>}</main>;
  }

  return (
    <main className="app-shell" style={{ '--ui-scale': state.settings.scale / 100 } as CSSProperties}>
      <header className="topbar">
        <div className="brand-lockup"><span className="brand-mark" aria-hidden="true">P</span><div><strong>{t(language, 'appName')}</strong><span>{t(language, 'eyebrow')}</span></div></div>
        <div className="topbar-actions">
          <button type="button" className="button button-quiet" onClick={exportCatalog} disabled={busy}>{t(language, 'export')}</button>
          <button type="button" className="button button-quiet" onClick={importCatalog} disabled={busy}>{t(language, 'import')}</button>
          <div className="setting-group"><label htmlFor="language-select">{t(language, 'language')}</label><select id="language-select" value={language} disabled={busy} onChange={(event) => setLanguage(event.target.value as Language)}><option value="en">{t(language, 'english')}</option><option value="ru">{t(language, 'russian')}</option></select></div>
          <div className="setting-group"><label htmlFor="scale-select">{t(language, 'scale')}</label><select id="scale-select" value={state.settings.scale} disabled={busy} onChange={(event) => setScale(Number(event.target.value) as UiScale)}><option value="100">{t(language, 'scale100')}</option><option value="115">{t(language, 'scale115')}</option><option value="130">{t(language, 'scale130')}</option></select></div>
        </div>
      </header>
      <div className="status-line" role="status" aria-live="polite" aria-busy={busy}>{t(language, status?.key ?? 'ready', status?.vars)}</div>
      <LiveSaveStrip state={state} language={language} busy={busy} onChoosePath={choosePath} onCapture={() => setModal({ kind: 'capture', value: '' })} />
      <div className="workspace">
        <SnapshotList snapshots={snapshots} selectedId={selectedId} language={language} search={search} sort={sort} disabled={busy} onSearch={setSearch} onSort={setSort} onSelect={setSelectedId} />
        <DetailPane snapshot={selected} language={language} disabled={busy} onRename={(title) => selected && setModal({ kind: 'rename', id: selected.id, value: title })} onRestore={() => selected && setModal({ kind: 'restore', id: selected.id })} onDelete={() => selected && setModal({ kind: 'delete', id: selected.id })} />
      </div>
      {modal?.kind === 'capture' && <ActionModal language={language} title={t(language, 'captureTitle')} description={t(language, 'captureHint')} value={modal.value} onValue={(value) => setModal({ kind: 'capture', value })} onCancel={() => setModal(null)} onConfirm={capture} confirmLabel={t(language, 'capture')} inputLabel={t(language, 'captureTitle')} busy={busy} />}
      {modal?.kind === 'rename' && <ActionModal language={language} title={t(language, 'renameTitle')} value={modal.value} onValue={(value) => setModal({ kind: 'rename', id: modal.id, value })} onCancel={() => setModal(null)} onConfirm={rename} confirmLabel={t(language, 'saveName')} inputLabel={t(language, 'renameTitle')} busy={busy} />}
      {modal?.kind === 'restore' && <ActionModal language={language} title={t(language, 'restoreConfirmTitle')} description={t(language, 'restoreConfirm')} value="" onValue={() => undefined} onCancel={() => setModal(null)} onConfirm={restore} confirmLabel={t(language, 'confirmRestore')} busy={busy} />}
      {modal?.kind === 'delete' && <ActionModal language={language} title={t(language, 'deleteConfirmTitle')} description={t(language, 'deleteConfirm')} value="" onValue={() => undefined} onCancel={() => setModal(null)} onConfirm={remove} confirmLabel={t(language, 'confirmDelete')} destructive busy={busy} />}
    </main>
  );
}
