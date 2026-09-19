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
  | { kind: 'restore'; id: string; launch: boolean }
  | { kind: 'delete'; id: string }
  | null;

type StatusState = { key: CopyKey; vars?: Record<string, string | number> };

function friendlyErrorStatus(error: unknown): StatusState {
  const message = error instanceof Error ? error.message : '';
  const temporaryPath = message.match(/Temporary recovery file preserved at (.+)$/i)?.[1]?.trim();
  if (temporaryPath) return { key: /changed while restore/i.test(message) ? 'restoreChangedWithTemp' : 'restoreFailedWithTemp', vars: { path: temporaryPath } };
  if (/Close PEPPERED|закройте PEPPERED|Could not verify|changed while restore|guarded replacement failed/i.test(message)) return { key: 'closeGame' };
  if (/capture source changed|changed while it was being read/i.test(message)) return { key: 'saveChangedDuringCapture' };
  if (/not a supported PEPPERED Easy Save 3 document/i.test(message)) return { key: 'unsupportedSave' };
  if (/Save is empty|not valid JSON|not valid UTF-8/i.test(message)) return { key: 'invalidSave' };
  if (/not found|не найдено/i.test(message)) return { key: 'notFound' };
  if (/path|путь|Save\.es3/i.test(message)) return { key: 'setPathFirst' };
  return { key: 'actionFailed' };
}

function suggestedCaptureTitle(state: AppState, language: Language): string {
  const summary = state.live.summary;
  if (!summary) return '';
  const scene = summary.sceneCode?.trim() ?? '';
  const description = summary.description[language]?.trim() ?? '';
  if (scene && description) return `${scene} — ${description}`.slice(0, 160);
  return (description || scene).slice(0, 160);
}

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<'newest' | 'oldest' | 'title'>('newest');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState>(null);
  const [modalError, setModalError] = useState<StatusState | null>(null);
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

  const runMutation = async (operation: () => Promise<void>, success?: StatusState, onError?: (error: StatusState) => void) => {
    const token = ++operationRef.current;
    setBusy(true);
    setStatus({ key: 'working' });
    try {
      await operation();
      if (token === operationRef.current && success) setStatus(success);
    } catch (error) {
      if (token === operationRef.current) {
        const friendly = friendlyErrorStatus(error);
        setStatus(friendly);
        onError?.(friendly);
      }
    } finally {
      if (token === operationRef.current) setBusy(false);
    }
  };

  const openModal = (next: Exclude<ModalState, null>) => { setModalError(null); setModal(next); };
  const closeModal = () => { setModalError(null); setModal(null); };

  const choosePath = () => void runMutation(async () => {
    const next = await window.peppered.chooseSavePath();
    if (next) setState(next);
  }, { key: 'ready' });

  const capture = () => {
    setModalError(null);
    void runMutation(async () => {
      if (!state || state.live.state !== 'detected' || !modal || modal.kind !== 'capture') throw new Error('Choose a valid Save.es3 path');
      const result = await window.peppered.capture(modal.value.trim());
      setState(result.state);
      setSelectedId(result.snapshot.id);
      closeModal();
      setStatus({ key: result.kind === 'created' ? 'capturedStatus' : 'duplicateStatus' });
    }, undefined, setModalError);
  };

  const rename = () => void runMutation(async () => {
    if (!modal || modal.kind !== 'rename') return;
    setState(await window.peppered.rename(modal.id, modal.value.trim()));
    closeModal();
  }, { key: 'renamedStatus' }, setModalError);

  const remove = () => void runMutation(async () => {
    if (!modal || modal.kind !== 'delete') return;
    setState(await window.peppered.delete(modal.id));
    closeModal();
  }, { key: 'deletedStatus' }, setModalError);

  const restore = () => void runMutation(async () => {
    if (!modal || modal.kind !== 'restore') return;
    if (modal.launch) {
      const result = await window.peppered.restoreAndLaunch(modal.id);
      setState(result.state);
      closeModal();
      setStatus({ key: result.launchRequested ? 'restoredAndLaunchedStatus' : 'restoredLaunchFailedStatus' });
    } else {
      const result = await window.peppered.restore(modal.id);
      setState(result.state);
      closeModal();
      setStatus({ key: result.safetySnapshotId ? 'restoredStatus' : result.previousState === 'absent' ? 'restoredCreatedStatus' : 'restoredNoBackupStatus' });
    }
  }, undefined, setModalError);

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
      <LiveSaveStrip state={state} language={language} busy={busy} onChoosePath={choosePath} onCapture={() => openModal({ kind: 'capture', value: suggestedCaptureTitle(state, language) })} />
      <div className="workspace">
        <SnapshotList snapshots={snapshots} selectedId={selectedId} language={language} search={search} sort={sort} disabled={busy} onSearch={setSearch} onSort={setSort} onSelect={setSelectedId} />
        <DetailPane snapshot={selected} language={language} disabled={busy} onRename={(title) => selected && openModal({ kind: 'rename', id: selected.id, value: title })} onRestore={() => selected && openModal({ kind: 'restore', id: selected.id, launch: false })} onRestoreAndLaunch={() => selected && openModal({ kind: 'restore', id: selected.id, launch: true })} onDelete={() => selected && openModal({ kind: 'delete', id: selected.id })} />
      </div>
      {modal?.kind === 'capture' && <ActionModal language={language} title={t(language, 'captureTitle')} description={t(language, 'captureHint')} error={modalError ? t(language, modalError.key, modalError.vars) : undefined} value={modal.value} onValue={(value) => { setModalError(null); setModal({ kind: 'capture', value }); }} onCancel={closeModal} onConfirm={capture} confirmLabel={t(language, 'capture')} inputLabel={t(language, 'captureTitle')} busy={busy} />}
      {modal?.kind === 'rename' && <ActionModal language={language} title={t(language, 'renameTitle')} error={modalError ? t(language, modalError.key, modalError.vars) : undefined} value={modal.value} onValue={(value) => { setModalError(null); setModal({ kind: 'rename', id: modal.id, value }); }} onCancel={closeModal} onConfirm={rename} confirmLabel={t(language, 'saveName')} inputLabel={t(language, 'renameTitle')} busy={busy} />}
      {modal?.kind === 'restore' && <ActionModal language={language} title={t(language, 'restoreConfirmTitle')} description={t(language, modal.launch ? 'restoreLaunchConfirm' : 'restoreConfirm')} error={modalError ? t(language, modalError.key, modalError.vars) : undefined} value="" onValue={() => undefined} onCancel={closeModal} onConfirm={restore} confirmLabel={t(language, modal.launch ? 'restoreAndLaunch' : 'confirmRestore')} busy={busy} />}
      {modal?.kind === 'delete' && <ActionModal language={language} title={t(language, 'deleteConfirmTitle')} description={t(language, 'deleteConfirm')} error={modalError ? t(language, modalError.key, modalError.vars) : undefined} value="" onValue={() => undefined} onCancel={closeModal} onConfirm={remove} confirmLabel={t(language, 'confirmDelete')} destructive busy={busy} />}
    </main>
  );
}
