import type { AppState } from '../../shared/ipc';
import type { Language } from '../../shared/types';
import { t } from '../i18n';

interface LiveSaveStripProps {
  state: AppState;
  language: Language;
  busy: boolean;
  onChoosePath: () => void;
  onCapture: () => void;
}

export function LiveSaveStrip({ state, language, busy, onChoosePath, onCapture }: LiveSaveStripProps) {
  const statusKey = state.live.state === 'detected' ? 'detected' : state.live.state;
  const copyKey = state.live.state === 'detected' ? 'detectedCopy' : `${state.live.state}Copy` as 'missingCopy' | 'invalidCopy' | 'unreadableCopy';
  return (
    <section className={`live-strip live-${state.live.state}`} aria-labelledby="live-save-heading">
      <div className="live-signal" aria-hidden="true"><span /></div>
      <div className="live-copy">
        <div className="section-kicker" id="live-save-heading">{t(language, 'liveSave')}</div>
        <strong>{t(language, statusKey)}</strong>
        <p>{t(language, copyKey)}</p>
      </div>
      <div className="live-path">
        <span>{t(language, 'selectLive')}</span>
        <code title={state.activePath}>{state.activePath}</code>
      </div>
      <div className="live-actions">
        <button type="button" className="button button-quiet" onClick={onChoosePath} disabled={busy}>{t(language, 'choosePath')}</button>
        <button type="button" className="button button-primary" onClick={onCapture} disabled={busy || state.live.state !== 'detected'}>{t(language, 'saveCurrent')}</button>
      </div>
    </section>
  );
}
