import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { SquareTerminal, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  killTerminal,
  resizeTerminal,
  startTerminal,
  terminalAvailable,
  writeTerminal,
} from "../lib/terminal";
import { isTauri } from "../lib/tauriBridge";

type TerminalPanelProps = {
  /** False hides the panel but keeps the shell running behind it. */
  active: boolean;
  /** Re-themes the buffer when the app's theme changes. */
  themeId: string;
  onHide: () => void;
};

type DataEvent = { id: string; data: string };
type ExitEvent = { id: string };

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

/** xterm paints on a canvas, so it needs real colours, not `color-mix()`. */
function terminalTheme() {
  const styles = getComputedStyle(document.documentElement);
  const background = styles.getPropertyValue("--nx-bg").trim() || "#000000";
  const foreground = styles.getPropertyValue("--nx-fg").trim() || "#ffffff";
  const accent = styles.getPropertyValue("--nx-accent").trim() || foreground;

  return {
    background,
    foreground,
    cursor: accent,
    cursorAccent: background,
    selectionBackground: /^#[0-9a-f]{6}$/i.test(accent)
      ? `${accent}55`
      : foreground,
  };
}

export default function TerminalPanel({
  active,
  themeId,
  onHide,
}: TerminalPanelProps) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const [shell, setShell] = useState("");
  const [error, setError] = useState<string | null>(null);

  // The shell starts once, when the panel is first opened, and then belongs to
  // the panel for as long as it stays mounted: hiding it keeps scrollback.
  useEffect(() => {
    if (!isTauri()) {
      return;
    }

    const element = host.current;

    if (!element) {
      return;
    }

    const instance = new Terminal({
      fontFamily: '"JetBrains Mono", ui-monospace, monospace',
      fontSize: 12,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 5000,
      theme: terminalTheme(),
    });
    const fitAddon = new FitAddon();

    instance.loadAddon(fitAddon);
    instance.open(element);

    if (element.clientWidth > 0 && element.clientHeight > 0) {
      fitAddon.fit();
    }

    terminal.current = instance;
    fit.current = fitAddon;

    const id = `terminal-${crypto.randomUUID()}`;
    let disposed = false;
    let unlisten: UnlistenFn[] = [];
    let input: { dispose: () => void } | null = null;

    const observer = new ResizeObserver(() => {
      if (disposed || element.clientWidth === 0) {
        return;
      }

      fitAddon.fit();
      void resizeTerminal(id, instance.rows, instance.cols).catch(() => {
        // A resize racing the shell's exit needs no message of its own.
      });
    });

    observer.observe(element);

    void (async () => {
      try {
        const stops = await Promise.all([
          listen<DataEvent>("terminal:data", (event) => {
            if (event.payload.id !== id) {
              return;
            }

            instance.write(decodeBase64(event.payload.data));
          }),
          listen<ExitEvent>("terminal:exit", (event) => {
            if (event.payload.id !== id) {
              return;
            }

            instance.write("\r\n\x1b[2m[process exited]\x1b[0m\r\n");
          }),
        ]);

        if (disposed) {
          stops.forEach((stop) => stop());

          return;
        }

        unlisten = stops;

        const started = startTerminal(id, instance.rows, instance.cols);

        // Attached before the shell can answer anything: ConPTY asks for the
        // cursor position at startup and waits, and xterm replies through this
        // handler. Queueing on `started` keeps the first keystrokes in order.
        input = instance.onData((data) => {
          void started
            .then(() => writeTerminal(id, data))
            .catch((cause) => {
              setError(
                cause instanceof Error
                  ? cause.message
                  : "The terminal could not be written to.",
              );
            });
        });

        const name = await started;

        if (disposed) {
          void killTerminal(id);

          return;
        }

        setShell(name);
        instance.focus();
      } catch (cause) {
        if (!disposed) {
          setError(
            cause instanceof Error
              ? cause.message
              : "The terminal could not start.",
          );
        }
      }
    })();

    return () => {
      disposed = true;
      observer.disconnect();
      input?.dispose();
      unlisten.forEach((stop) => stop());
      instance.dispose();
      terminal.current = null;
      fit.current = null;
      void killTerminal(id);
    };
  }, []);

  useEffect(() => {
    if (terminal.current) {
      terminal.current.options.theme = terminalTheme();
    }
  }, [themeId]);

  // A hidden panel has no dimensions, so the grid is fitted when it comes back.
  useEffect(() => {
    if (!active) {
      return;
    }

    const frame = requestAnimationFrame(() => {
      if (host.current && host.current.clientWidth > 0) {
        fit.current?.fit();
        terminal.current?.focus();
      }
    });

    return () => cancelAnimationFrame(frame);
  }, [active]);

  return (
    <section
      aria-label="Terminal"
      className={`${active ? "flex" : "hidden"} h-[260px] shrink-0 flex-col border-t border-line bg-app`}
    >
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-2.5">
        <SquareTerminal
          className="size-3.5 shrink-0 text-ink/35"
          strokeWidth={1.75}
        />
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink/40">
          Terminal
        </span>
        {shell && (
          <span className="truncate font-mono text-[10px] text-ink/25">
            {shell}
          </span>
        )}
        <button
          type="button"
          onClick={onHide}
          aria-label="Hide terminal"
          title="Hide terminal (Ctrl+`)"
          className="ml-auto flex size-5 items-center justify-center rounded text-ink/30 transition-colors duration-150 hover:bg-ink/[0.08] hover:text-ink"
        >
          <X className="size-3" strokeWidth={2} />
        </button>
      </div>

      {error && (
        <p className="shrink-0 border-b border-line px-3 py-1 text-[11px] text-red-300/80">
          {error}
        </p>
      )}

      {terminalAvailable() ? (
        <div ref={host} className="min-h-0 flex-1 overflow-hidden px-2 py-1" />
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center px-4">
          <p className="max-w-sm text-center text-[11.5px] leading-relaxed text-ink/35">
            The terminal runs in the desktop app. This browser preview has no
            shell to attach it to.
          </p>
        </div>
      )}
    </section>
  );
}
