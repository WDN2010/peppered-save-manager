import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import type { Language } from '../../shared/types';
import { t } from '../i18n';

interface ActionModalProps {
  language: Language;
  title: string;
  description?: string;
  error?: string;
  value: string;
  onValue: (value: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
  confirmLabel: string;
  children?: ReactNode;
  destructive?: boolean;
  inputLabel?: string;
  busy?: boolean;
}

export function ActionModal({ language, title, description, error, value, onValue, onCancel, onConfirm, confirmLabel, children, destructive, inputLabel, busy = false }: ActionModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    dialog?.showModal();
    (inputLabel ? inputRef.current : confirmRef.current)?.focus();
    return () => {
      if (dialog?.open) dialog.close();
      previous?.focus?.();
    };
  }, [inputLabel]);
  return (
    <dialog ref={dialogRef} className="action-dialog" onCancel={(event) => { event.preventDefault(); if (!busy) onCancel(); }} aria-labelledby="dialog-heading">
      <form method="dialog" onSubmit={(event) => { event.preventDefault(); if (!busy) onConfirm(); }}>
        <div className="dialog-kicker">PEPPERED</div>
        <h2 id="dialog-heading">{title}</h2>
        {description && <p>{description}</p>}
        {error && <p className="dialog-error" role="alert">{error}</p>}
        {inputLabel && <label className="dialog-label"><span>{inputLabel}</span><input ref={inputRef} value={value} onChange={(event) => onValue(event.target.value)} maxLength={160} required disabled={busy} /></label>}
        {children}
        <div className="dialog-actions">
          <button type="button" className="button button-quiet" onClick={onCancel} disabled={busy}>{t(language, 'cancel')}</button>
          <button ref={confirmRef} type="submit" className={`button ${destructive ? 'button-danger' : 'button-primary'}`} disabled={busy || Boolean(inputLabel && !value.trim())}>{confirmLabel}</button>
        </div>
      </form>
    </dialog>
  );
}
