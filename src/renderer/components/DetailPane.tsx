import { useState } from 'react';
import type { Language, SnapshotMeta } from '../../shared/types';
import { t } from '../i18n';

interface DetailPaneProps {
  snapshot: SnapshotMeta | null;
  language: Language;
  onRename: (title: string) => void;
  onRestore: () => void;
  onDelete: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes < 1024 * 100 ? 1 : 0)} KB`;
}

export function DetailPane({ snapshot, language, onRename, onRestore, onDelete }: DetailPaneProps) {
  const [technical, setTechnical] = useState(false);
  if (!snapshot) return <section className="detail-panel detail-empty" aria-live="polite"><span className="empty-mark" aria-hidden="true">↗</span><strong>{t(language, 'noSelection')}</strong></section>;
  const description = snapshot.summary.description[language];
  const locale = language === 'ru' ? 'ru-RU' : 'en-US';
  return (
    <section className="detail-panel" aria-labelledby="detail-heading">
      <div className="detail-topline"><span className="route-chip">{snapshot.summary.sceneCode ?? '•'}</span><time dateTime={snapshot.capturedAt}>{t(language, 'captured')} · {new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(snapshot.capturedAt))}</time></div>
      <div className="detail-heading-row">
        <div>
          <div className="section-kicker">{description}</div>
          <h1 id="detail-heading">{snapshot.title}</h1>
        </div>
        <div className="detail-actions">
          <button type="button" className="button button-primary" onClick={onRestore}>{t(language, 'restore')}</button>
          <button type="button" className="button button-quiet" onClick={() => onRename(snapshot.title)}>{t(language, 'rename')}</button>
          <button type="button" className="button button-danger" onClick={onDelete}>{t(language, 'delete')}</button>
        </div>
      </div>
      <div className="checkpoint-card">
        <span className="checkpoint-dot" aria-hidden="true" />
        <div><span className="card-label">{t(language, 'snapshots')}</span><strong>{description}</strong><p>{language === 'ru' ? 'Безопасная копия полного состояния сохранения.' : 'A safe copy of the complete persisted game state.'}</p></div>
      </div>
      <button type="button" className="technical-toggle" aria-expanded={technical} onClick={() => setTechnical((value) => !value)}>{technical ? t(language, 'hideTechnical') : t(language, 'technical')}<span aria-hidden="true">{technical ? '−' : '+'}</span></button>
      {technical && <dl className="technical-grid">
        <div><dt>{t(language, 'scene')}</dt><dd>{snapshot.summary.sceneCode ?? '—'}</dd></div>
        <div><dt>{t(language, 'hash')}</dt><dd className="hash-value">{snapshot.sha256}</dd></div>
        <div><dt>{t(language, 'bytes')}</dt><dd>{formatBytes(snapshot.bytes)}</dd></div>
        <div><dt>{t(language, 'source')}</dt><dd className="path-value">{snapshot.sourcePath}</dd></div>
      </dl>}
      <div className="stats-grid" aria-label={language === 'ru' ? 'Сводка точки' : 'Checkpoint summary'}>
        <div><span>{language === 'ru' ? 'Смертей' : 'Deaths'}</span><strong>{snapshot.summary.deathCount ?? '—'}</strong></div>
        <div><span>{language === 'ru' ? 'Глава' : 'Chapter'}</span><strong>{snapshot.summary.chapter ?? '—'}</strong></div>
        <div><span>{language === 'ru' ? 'Звёзды' : 'Stars'}</span><strong>{snapshot.summary.stars ?? '—'}</strong></div>
        <div><span>{language === 'ru' ? 'Монеты' : 'Coins'}</span><strong>{snapshot.summary.coins ?? '—'}</strong></div>
      </div>
    </section>
  );
}
