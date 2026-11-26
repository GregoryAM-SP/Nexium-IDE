import { AlertTriangle } from "lucide-react";
import { useEffect, useRef } from "react";

type ConfirmDialogProps = {
  title: string;
  description: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
};

/**
 * A permanent action has no undo, so it gets a modal with the safe choice
 * focused, Escape cancelling, and the shortcut claimed before the shell sees it.
 */
export default function ConfirmDialog({
  title,
  description,
  confirmLabel,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      }
    };

    window.addEventListener("keydown", onKeyDown, true);

    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-app/70 p-6 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onCancel();
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        className="w-full max-w-[380px] rounded-2xl border border-ink/10 bg-raised p-5 shadow-[0_30px_80px_-20px_rgba(0,0,0,0.95)]"
      >
        <div className="flex items-start gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-red-500/10 ring-1 ring-red-500/25 ring-inset">
            <AlertTriangle
              className="size-4 text-red-400/90"
              strokeWidth={1.75}
            />
          </span>
          <div className="min-w-0">
            <h2
              id="confirm-dialog-title"
              className="break-words text-[13.5px] font-semibold text-ink/90"
            >
              {title}
            </h2>
            <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink/45">
              {description}
            </p>
          </div>
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="h-7 rounded-md border border-ink/10 bg-ink/[0.02] px-3 text-[11.5px] text-ink/60 transition-colors duration-150 hover:border-ink/20 hover:bg-ink/[0.05] hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="h-7 rounded-md bg-red-500 px-3 text-[11.5px] font-medium text-ink transition-colors duration-150 hover:bg-red-400"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
