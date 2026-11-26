import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, Minus, Square, X } from "lucide-react";
import { useEffect, useState } from "react";

import { isTauri } from "../lib/tauriBridge";

const buttonClass =
  "flex h-full w-[46px] items-center justify-center text-ink/45 transition-colors duration-150";

/**
 * The native title bar is disabled, so these replace it. They stay hidden in
 * the browser build, which has no window to control.
 */
export default function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!isTauri()) {
      return;
    }

    const appWindow = getCurrentWindow();
    let active = true;
    let stop: (() => void) | null = null;

    void appWindow.isMaximized().then((value) => {
      if (active) {
        setMaximized(value);
      }
    });

    void appWindow
      .onResized(() => {
        void appWindow.isMaximized().then((value) => {
          if (active) {
            setMaximized(value);
          }
        });
      })
      .then((unlisten) => {
        if (active) {
          stop = unlisten;
        } else {
          unlisten();
        }
      });

    return () => {
      active = false;
      stop?.();
    };
  }, []);

  if (!isTauri()) {
    return null;
  }

  const appWindow = getCurrentWindow();

  return (
    <div className="flex h-full items-stretch border-l border-line pl-1">
      <button
        type="button"
        onClick={() => void appWindow.minimize()}
        aria-label="Minimize window"
        title="Minimize"
        className={`${buttonClass} hover:bg-ink/[0.07] hover:text-ink`}
      >
        <Minus className="size-3.5" strokeWidth={2} />
      </button>

      <button
        type="button"
        onClick={() => void appWindow.toggleMaximize()}
        aria-label={maximized ? "Restore window" : "Maximize window"}
        title={maximized ? "Restore" : "Maximize"}
        className={`${buttonClass} hover:bg-ink/[0.07] hover:text-ink`}
      >
        {maximized ? (
          <Copy className="size-3" strokeWidth={2} />
        ) : (
          <Square className="size-3" strokeWidth={2} />
        )}
      </button>

      <button
        type="button"
        onClick={() => void appWindow.close()}
        aria-label="Close window"
        title="Close"
        className={`${buttonClass} hover:bg-red-600 hover:text-ink`}
      >
        <X className="size-3.5" strokeWidth={2} />
      </button>
    </div>
  );
}
