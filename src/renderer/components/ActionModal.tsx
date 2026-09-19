import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import type { Language } from '../../shared/types';
import { t } from '../i18n';

interface ActionModalProps {
  language: Language;
  title: string;
  description?: string;
  value: string;
  onValue: (value: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
  confirmLabel: string;
  children?: ReactNode;
  destructive?: boolean;
  inputLabel?: string;
}

export function ActionModal({ language, title, description, value, onValue, onCancel, onConfirm, confirmLabel, children, destructive, inputLabel }: ActionModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { dialogRef.current?.showModal(); inputRef.current?.focus(); }, []);
  return (
    <dialog ref={dialogRef} className="action-dialog" onCancel={onCancel} aria-labelledby="dialog-heading">
      <form method="dialog" onSubmit={(event) => { event.preventDefault(); onConfirm(); }}>
        <div className="dialog-kicker">PEPPERED</div>
        <h2 id="dialog-heading">{title}</h2>
        {description && <p>{description}</p>}
        {inputLabel && <label className="dialog-label"><span>{inputLabel}</span><input ref={inputRef} value={value} onChange={(event) => onValue(event.target.value)} maxLength={160} required /></label>}
        {children}
        <div className="dialog-actions">
          <button type="button" className="button button-quiet" onClick={onCancel}>{t(language, 'cancel')}</button>
          <button type="submit" className={`button ${destructive ? 'button-danger' : 'button-primary'}`} disabled={Boolean(inputLabel && !value.trim())}>{confirmLabel}</button>
        </div>
      </form>
    </dialog>
  );
}
