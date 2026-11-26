import { getVersion } from "@tauri-apps/api/app";
import { useEffect, useRef, useState } from "react";

import { isTauri } from "../lib/tauriBridge";

type AboutDialogProps = {
  onClose: () => void;
};

/** Help → About Nexium: what the app is, and which version is running. */
export default function AboutDialog({ onClose }: AboutDialogProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    closeRef.current?.focus();

    if (isTauri()) {
      void getVersion()
        .then(setVersion)
        .catch(() => setVersion(null));
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // Claim the key so the assistant's full-screen Escape does not also fire.
        event.preventDefault();
        onClose();
      }
    };

    window.addEventListener("keydown", onKeyDown, true);

    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-app/70 p-6 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-dialog-title"
        className="w-full max-w-[380px] rounded-2xl border border-ink/10 bg-raised p-5 shadow-[0_30px_80px_-20px_rgba(0,0,0,0.95)]"
      >
        <div className="flex items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-b from-ink/[0.11] to-ink/[0.03] shadow-[inset_0_1px_0_color-mix(in_srgb,var(--color-ink)_8%,transparent)] ring-1 ring-ink/10">
            <img src="/nexium.svg" alt="" className="size-5" />
          </span>
          <div className="min-w-0">
            <h2
              id="about-dialog-title"
              className="text-[14px] font-semibold tracking-[-0.01em] text-ink/90"
            >
              Nexium Studio
            </h2>
            <p className="mt-0.5 font-mono text-[10.5px] text-ink/35">
              {version ? `Version ${version}` : "Development build"}
            </p>
          </div>
        </div>

        <p className="mt-4 text-[11.5px] leading-relaxed text-ink/45">
          A local code editor. Open a folder, edit its files, review changes with
          Git and let the assistant work on the same files — the desktop shell
          reads and writes them; the browser demo runs on sample sources.
        </p>

        <p className="mt-3 font-mono text-[10.5px] text-ink/30">
          Tauri 2 · Rust · React 19 · Monaco
        </p>

        <div className="mt-5 flex items-center justify-end">
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="h-7 rounded-md bg-ink px-3 text-[11.5px] font-medium text-app transition-colors duration-150 hover:bg-ink/90"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
