import { type ReactNode, useEffect, useRef } from 'react';
import { X } from 'lucide-react';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
}

/** Accessible modal built on the native <dialog> element (focus trap + Esc handled by the browser). */
export function Dialog({ open, onClose, title, description, children }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      aria-labelledby="dialog-title"
      className="m-auto w-[calc(100%-2rem)] max-w-lg rounded-xl bg-canvas p-0 text-ink shadow-card backdrop:bg-ink/40"
    >
      {open && (
        <div className="p-6">
          <div className="mb-5 flex items-start justify-between gap-4">
            <div>
              <h2 id="dialog-title" className="text-display-sm font-bold">
                {title}
              </h2>
              {description && <p className="mt-1 text-sm text-body">{description}</p>}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-pill p-1.5 hover:bg-canvas-soft"
              aria-label="Close dialog"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
}
