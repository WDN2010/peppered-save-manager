import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import type { AppState } from '../shared/ipc';
import type { Language, UiScale } from '../shared/types';
import { ActionModal } from './components/ActionModal';
import { DetailPane } from './components/DetailPane';
import { LiveSaveStrip } from './components/LiveSaveStrip';
import { SnapshotList } from './components/SnapshotList';
import { t } from './i18n';

 type ModalState =
  | { kind: 'capture'; value: string }
  | { kind: 'rename'; value: string; id: string }
  | { kind: 'restore'; id: string }
  | { kind: 'delete'; id: string }
  | null;

function friendlyError(error: unknown, language: Language): string {
  const message = error instanceof Error ? error.message : '';
  if (/Close PEPPERED|закройте PEPPERED/i.test(message)) return t(language, 'closeGame');
  if (/not found|не найдено/i.test(message)) return t(language, 'notFound');
  if (/path|путь|Save\.es3/i.test(message)) return t(language, 'setPathFirst');
  return t(language, 'actionFailed');
}

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<'newest' | 'oldest' | 'title'>('newest');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState>(null);
  const [status, setStatus] = useState('');

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
  const snapshots = useMemo(() => {
    if (!state) return [];
    const term = search.trim().toLocaleLowerCase(language === 'ru' ? 'ru-RU' : 'en-US');
    const visible = state.snapshots.filter((snapshot) => !term || `${snapshot.title} ${snapshot.summary.description.en} ${snapshot.summary.description.ru}`.toLocaleLowerCase().includes(term));
    return visible.sort((a, b) => sort === 'title' ? a.title.localeCompare(b.title, language) : sort === 'newest' ? b.capturedAt.localeCompare(a.capturedAt) : a.capturedAt.localeCompare(b.capturedAt));
  }, [state, search, sort, language]);
  const selected = state?.snapshots.find((snapshot) => snapshot.id === selectedId) ?? null;

  const updateState = async (next: Promise<AppState>) => {
    try { setState(await next); } catch (error) { setStatus(friendlyError(error, language)); }
  };
  const choosePath = async () => {
    try {
      const next = await window.peppered.chooseSavePath();
      if (next) { setState(next); setStatus(t(language, 'ready')); }
    } catch (error) { setStatus(friendlyError(error, language)); }
  };
  const capture = async () => {
    if (!state || state.live.state !== 'detected') { setStatus(t(language, 'setPathFirst')); return; }
    if (!modal || modal.kind !== 'capture') return;
    try {
      const result = await window.peppered.capture(modal.value.trim());
      setState(result.state); setSelectedId(result.snapshot.id); setModal(null);
      setStatus(t(language, result.kind === 'created' ? 'capturedStatus' : 'duplicateStatus'));
    } catch (error) { setStatus(friendlyError(error, language)); }
  };
  const rename = async () => {
    if (!modal || modal.kind !== 'rename') return;
    try {
      setState(await window.peppered.rename(modal.id, modal.value.trim())); setModal(null); setStatus(t(language, 'renamedStatus'));
    } catch (error) { setStatus(friendlyError(error, language)); }
  };
  const remove = async () => {
    if (!modal || modal.kind !== 'delete') return;
    try {
      setState(await window.peppered.delete(modal.id)); setModal(null); setStatus(t(language, 'deletedStatus'));
    } catch (error) { setStatus(friendlyError(error, language)); }
  };
  const restore = async () => {
    if (!modal || modal.kind !== 'restore') return;
    try {
      const result = await window.peppered.restore(modal.id);
      setState(result.state); setModal(null); setStatus(t(language, result.safetySnapshotId ? 'restoredStatus' : 'restoredNoBackupStatus'));
    } catch (error) { setStatus(friendlyError(error, language)); }
  };
  const exportCatalog = async () => {
    try { await window.peppered.exportCatalog(); setStatus(t(language, 'exportedStatus')); } catch (error) { if (!/cancel/i.test(error instanceof Error ? error.message : '')) setStatus(friendlyError(error, language)); }
  };
  const importCatalog = async () => {
    try {
      const result = await window.peppered.importCatalog();
      await refresh(); setStatus(`${t(language, 'importedStatus')} ${t(language, 'importedSummary', { added: result.added, skipped: result.skipped, rejected: result.rejected })}`);
    } catch (error) { if (!/cancel/i.test(error instanceof Error ? error.message : '')) setStatus(friendlyError(error, language)); }
  };
  const setLanguage = (value: Language) => void updateState(window.peppered.setSettings({ language: value }));
  const setScale = (value: UiScale) => void updateState(window.peppered.setSettings({ scale: value }));

  if (!state) {
    return <main className="loading-screen"><div className="brand-lockup"><span className="brand-mark" aria-hidden="true">P</span><div><strong>{t('en', 'appName')}</strong><span>{t('en', 'loading')}</span></div></div>{loadError && <button type="button" className="button button-primary" onClick={() => void refresh()}>{t('en', 'retry')}</button>}</main>;
  }

  return (
    <main className="app-shell" style={{ '--ui-scale': state.settings.scale / 100 } as CSSProperties}>
      <header className="topbar">
        <div className="brand-lockup"><span className="brand-mark" aria-hidden="true">P</span><div><strong>{t(language, 'appName')}</strong><span>{t(language, 'eyebrow')}</span></div></div>
        <div className="topbar-actions">
          <button type="button" className="button button-quiet" onClick={() => void exportCatalog()}>{t(language, 'export')}</button>
          <button type="button" className="button button-quiet" onClick={() => void importCatalog()}>{t(language, 'import')}</button>
          <div className="setting-group"><label htmlFor="language-select">{t(language, 'language')}</label><select id="language-select" value={language} onChange={(event) => setLanguage(event.target.value as Language)}><option value="en">{t(language, 'english')}</option><option value="ru">{t(language, 'russian')}</option></select></div>
          <div className="setting-group"><label htmlFor="scale-select">{t(language, 'scale')}</label><select id="scale-select" value={state.settings.scale} onChange={(event) => setScale(Number(event.target.value) as UiScale)}><option value="100">{t(language, 'scale100')}</option><option value="115">{t(language, 'scale115')}</option><option value="130">{t(language, 'scale130')}</option></select></div>
        </div>
      </header>
      <div className="status-line" role="status" aria-live="polite">{status || t(language, 'ready')}</div>
      <LiveSaveStrip state={state} language={language} onChoosePath={() => void choosePath()} onCapture={() => setModal({ kind: 'capture', value: '' })} />
      <div className="workspace">
        <SnapshotList snapshots={snapshots} selectedId={selectedId} language={language} search={search} sort={sort} onSearch={setSearch} onSort={setSort} onSelect={setSelectedId} />
        <DetailPane snapshot={selected} language={language} onRename={(title) => selected && setModal({ kind: 'rename', id: selected.id, value: title })} onRestore={() => selected && setModal({ kind: 'restore', id: selected.id })} onDelete={() => selected && setModal({ kind: 'delete', id: selected.id })} />
      </div>
      {modal?.kind === 'capture' && <ActionModal language={language} title={t(language, 'captureTitle')} description={t(language, 'captureHint')} value={modal.value} onValue={(value) => setModal({ kind: 'capture', value })} onCancel={() => setModal(null)} onConfirm={() => void capture()} confirmLabel={t(language, 'capture')} inputLabel={t(language, 'captureTitle')} />}
      {modal?.kind === 'rename' && <ActionModal language={language} title={t(language, 'renameTitle')} value={modal.value} onValue={(value) => setModal({ kind: 'rename', id: modal.id, value })} onCancel={() => setModal(null)} onConfirm={() => void rename()} confirmLabel={t(language, 'saveName')} inputLabel={t(language, 'renameTitle')} />}
      {modal?.kind === 'restore' && <ActionModal language={language} title={t(language, 'restoreConfirmTitle')} description={t(language, 'restoreConfirm')} value="" onValue={() => undefined} onCancel={() => setModal(null)} onConfirm={() => void restore()} confirmLabel={t(language, 'confirmRestore')} />}
      {modal?.kind === 'delete' && <ActionModal language={language} title={t(language, 'deleteConfirmTitle')} description={t(language, 'deleteConfirm')} value="" onValue={() => undefined} onCancel={() => setModal(null)} onConfirm={() => void remove()} confirmLabel={t(language, 'confirmDelete')} destructive />}
    </main>
  );
}
