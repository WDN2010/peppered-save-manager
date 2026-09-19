import type { Language, SnapshotMeta } from '../../shared/types';
import { t } from '../i18n';

interface SnapshotListProps {
  snapshots: SnapshotMeta[];
  selectedId: string | null;
  language: Language;
  search: string;
  sort: 'newest' | 'oldest' | 'title';
  disabled: boolean;
  onSearch: (value: string) => void;
  onSort: (value: 'newest' | 'oldest' | 'title') => void;
  onSelect: (id: string) => void;
}

export function SnapshotList({ snapshots, selectedId, language, search, sort, disabled, onSearch, onSort, onSelect }: SnapshotListProps) {
  return (
    <section className="library-panel" aria-labelledby="library-heading">
      <div className="library-heading-row">
        <div>
          <div className="section-kicker">{t(language, 'snapshots')}</div>
          <h2 id="library-heading">{snapshots.length}</h2>
        </div>
        <label className="visually-hidden" htmlFor="sort-select">{t(language, 'sort')}</label>
        <select id="sort-select" className="sort-select" value={sort} disabled={disabled} onChange={(event) => onSort(event.target.value as typeof sort)}>
          <option value="newest">{t(language, 'newest')}</option>
          <option value="oldest">{t(language, 'oldest')}</option>
          <option value="title">{t(language, 'titleAZ')}</option>
        </select>
      </div>
      <label className="search-field">
        <span className="search-icon" aria-hidden="true">⌕</span>
        <span className="visually-hidden">{t(language, 'search')}</span>
        <input value={search} disabled={disabled} onChange={(event) => onSearch(event.target.value)} placeholder={t(language, 'search')} />
      </label>
      {snapshots.length === 0 ? (
        <div className="list-empty"><span className="empty-mark" aria-hidden="true">{search ? '⌕' : '+'}</span><strong>{search ? t(language, 'noResults') : t(language, 'emptyTitle')}</strong><p>{search ? t(language, 'noResults') : t(language, 'emptyCopy')}</p></div>
      ) : (
        <ul className="snapshot-list" aria-label={t(language, 'snapshots')}>
          {snapshots.map((snapshot) => (
            <li key={snapshot.id}>
              <button type="button" className={`snapshot-row ${snapshot.id === selectedId ? 'selected' : ''}`} onClick={() => onSelect(snapshot.id)} aria-current={snapshot.id === selectedId ? 'true' : undefined} disabled={disabled}>
                <span className="row-marker" aria-hidden="true" />
                <span className="snapshot-row-copy">
                  <strong>{snapshot.kind === 'recovery' ? t(language, 'recoveryTitle') : snapshot.title}</strong>
                  <span>{snapshot.summary.description[language]}</span>
                  <time dateTime={snapshot.capturedAt}>{new Intl.DateTimeFormat(language === 'ru' ? 'ru-RU' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(snapshot.capturedAt))}</time>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
