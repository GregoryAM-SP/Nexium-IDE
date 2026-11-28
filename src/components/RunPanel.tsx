import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { listen } from "@tauri-apps/api/event";
import {
  Eraser,
  LoaderCircle,
  PanelRightClose,
  Play,
  RotateCw,
  Square,
  SquareTerminal,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { targetKey } from "../lib/runnable";
import type { RunChoice, Runnable } from "../lib/runnable";
import { isTauri } from "../lib/tauriBridge";
import { killTerminal, resizeTerminal, startTerminal, writeTerminal } from "../lib/terminal";

type RunPanelProps = {
  /** False hides the panel; a running program keeps running behind it. */
  active: boolean;
  targets: Runnable[];
  /** What was run last in this project, to preselect. */
  choice: RunChoice | null;
  onChoice: (choice: RunChoice) => void;
  /** A program started or stopped, for the rail's running dot. */
  onRunningChange: (running: boolean) => void;
  themeId: string;
  onHide: () => void;
};

type DataEvent = { id: string; data: string };
type ExitEvent = { id: string; code: number | null };

type Status =
  | { kind: "idle" }
  | { kind: "running"; started: number }
  | { kind: "exited"; code: number | null; seconds: number }
  | { kind: "stopped"; seconds: number }
  | { kind: "failed"; message: string };

const CUSTOM = "";

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

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
    selectionBackground: /^#[0-9a-f]{6}$/i.test(accent) ? `${accent}55` : foreground,
  };
}

function duration(seconds: number): string {
  return seconds < 60 ? `${seconds.toFixed(seconds < 10 ? 1 : 0)}s` : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

const selectClass =
  "h-7 w-full min-w-0 rounded-md border border-line bg-app px-2 pr-6 text-[11.5px] text-ink/80 focus:border-ink/25 focus:outline-none";
const iconButton =
  "flex size-6 shrink-0 items-center justify-center rounded-md text-ink/35 transition-colors duration-150 hover:bg-ink/[0.06] hover:text-ink disabled:text-ink/15";

/**
 * The Run panel: starts a program of the project (cargo run, go run .,
 * dotnet run, a Python script…) in its own terminal, so it can print in
 * colour and read keyboard input, and shows how it ended.
 */
export default function RunPanel({
  active,
  targets,
  choice,
  onChoice,
  onRunningChange,
  themeId,
  onHide,
}: RunPanelProps) {
  const initialTarget = targets.find((target) => targetKey(target) === choice?.target) ?? targets[0] ?? null;
  const [targetId, setTargetId] = useState(initialTarget ? targetKey(initialTarget) : "");
  const target = targets.find((entry) => targetKey(entry) === targetId) ?? targets[0] ?? null;
  const [taskName, setTaskName] = useState(() =>
    choice && initialTarget && targetKey(initialTarget) === choice.target ? choice.task : (initialTarget?.tasks[0]?.name ?? CUSTOM),
  );
  const [custom, setCustom] = useState(() => choice?.custom ?? "");
  const task = target?.tasks.find((entry) => entry.name === taskName) ?? null;
  const command = task ? task.command : custom;

  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [now, setNow] = useState(Date.now());
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const session = useRef<string | null>(null);
  const started = useRef(0);
  const running = status.kind === "running";

  // A target that disappeared (folder changed) falls back to the first one.
  useEffect(() => {
    if (target && targetKey(target) !== targetId) {
      setTargetId(targetKey(target));
      setTaskName(target.tasks[0]?.name ?? CUSTOM);
    }
  }, [target, targetId]);

  useEffect(() => {
    onRunningChange(running);
  }, [running, onRunningChange]);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  // One xterm for the panel's lifetime; each run gets a fresh session in it.
  useEffect(() => {
    const element = host.current;
    if (!element || !isTauri()) return;

    const instance = new Terminal({
      fontFamily: '"JetBrains Mono", ui-monospace, monospace',
      fontSize: 12,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 10000,
      convertEol: false,
      theme: terminalTheme(),
    });
    const fitAddon = new FitAddon();
    instance.loadAddon(fitAddon);
    instance.open(element);
    terminal.current = instance;
    fit.current = fitAddon;
    instance.write("\x1b[2mChoose what to run, then press Run. The program can read what you type here.\x1b[0m\r\n");

    const observer = new ResizeObserver(() => {
      if (element.clientWidth === 0) return;
      fitAddon.fit();
      const id = session.current;
      if (id) void resizeTerminal(id, instance.rows, instance.cols).catch(() => undefined);
    });
    observer.observe(element);

    // Keys go to the running program.
    const input = instance.onData((data) => {
      const id = session.current;
      if (id) void writeTerminal(id, data).catch(() => undefined);
    });

    let stops: (() => void)[] = [];
    let disposed = false;
    void Promise.all([
      listen<DataEvent>("terminal:data", (event) => {
        if (event.payload.id === session.current) {
          instance.write(decodeBase64(event.payload.data));
        }
      }),
      listen<ExitEvent>("terminal:exit", (event) => {
        if (event.payload.id !== session.current) return;
        // The exit code comes from a watcher; the output's end may come
        // first (without a code) or never, so the coded event wins.
        const { code } = event.payload;
        const finish = () => {
          if (event.payload.id !== session.current) return;
          session.current = null;
          // Frees the pseudo-terminal and the run script.
          void killTerminal(event.payload.id);
          const seconds = (Date.now() - started.current) / 1000;
          instance.write(
            code === null
              ? "\r\n\x1b[2mThe program ended.\x1b[0m\r\n"
              : `\r\n\x1b[${code === 0 ? "32" : "31"}mProcess finished with exit code ${code}\x1b[0m\x1b[2m · ${duration(seconds)}\x1b[0m\r\n`,
          );
          setStatus({ kind: "exited", code, seconds });
        };
        if (code === null) {
          window.setTimeout(finish, 800);
        } else {
          finish();
        }
      }),
    ]).then((list) => {
      if (disposed) list.forEach((stop) => stop());
      else stops = list;
    });

    return () => {
      disposed = true;
      observer.disconnect();
      input.dispose();
      stops.forEach((stop) => stop());
      if (session.current) void killTerminal(session.current);
      session.current = null;
      instance.dispose();
      terminal.current = null;
    };
  }, []);

  useEffect(() => {
    if (terminal.current) terminal.current.options.theme = terminalTheme();
  }, [themeId]);

  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => {
      if (host.current && host.current.clientWidth > 0) {
        fit.current?.fit();
        terminal.current?.focus();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [active]);

  const stop = async (note = true) => {
    const id = session.current;
    if (!id) return;
    session.current = null;
    await killTerminal(id);
    const seconds = (Date.now() - started.current) / 1000;
    if (note) {
      terminal.current?.write(`\r\n\x1b[33mStopped\x1b[0m\x1b[2m · ${duration(seconds)}\x1b[0m\r\n`);
      setStatus({ kind: "stopped", seconds });
    }
  };

  const run = async () => {
    const line = command.trim();
    const instance = terminal.current;
    if (!target || !line || !instance) return;

    await stop(false);
    onChoice({ target: targetKey(target), task: task ? task.name : CUSTOM, custom });

    instance.reset();
    instance.write(`\x1b[2m${target.dir ? `${target.dir}> ` : "> "}${line}\x1b[0m\r\n`);
    fit.current?.fit();

    const id = `run-${crypto.randomUUID()}`;
    session.current = id;
    started.current = Date.now();
    setNow(Date.now());
    setStatus({ kind: "running", started: started.current });

    try {
      await startTerminal(id, instance.rows, instance.cols, line, target.dir || null);
      instance.focus();
    } catch (cause) {
      session.current = null;
      const message = cause instanceof Error ? cause.message : "The program could not start.";
      instance.write(`\x1b[31m${message}\x1b[0m\r\n`);
      setStatus({ kind: "failed", message });
    }
  };

  const statusText = useMemo(() => {
    switch (status.kind) {
      case "running":
        return `Running · ${duration(Math.max(0, (now - status.started) / 1000))}`;
      case "exited":
        return status.code === null
          ? `Ended · ${duration(status.seconds)}`
          : `Exit code ${status.code} · ${duration(status.seconds)}`;
      case "stopped":
        return `Stopped · ${duration(status.seconds)}`;
      case "failed":
        return "Could not start";
      default:
        return "";
    }
  }, [status, now]);

  return (
    <aside
      aria-label="Run"
      className={`${active ? "flex" : "hidden"} w-[460px] shrink-0 flex-col border-l border-line bg-surface`}
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
        <SquareTerminal className="size-3.5 shrink-0 text-ink/40" strokeWidth={1.75} />
        <span className="text-[10px] font-medium uppercase tracking-[0.16em] text-ink/45">Run</span>
        {statusText && (
          <span
            className={`flex items-center gap-1.5 truncate text-[10.5px] ${
              status.kind === "exited" && status.code !== 0 && status.code !== null ? "text-red-300/80" : "text-ink/40"
            }`}
          >
            {running && <LoaderCircle className="size-3 animate-spin" />}
            {statusText}
          </span>
        )}
        <span className="ml-auto flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => terminal.current?.clear()}
            title="Clear the output"
            aria-label="Clear the output"
            className={iconButton}
          >
            <Eraser className="size-3.5" strokeWidth={1.75} />
          </button>
          <button type="button" onClick={onHide} title="Hide" aria-label="Hide the Run panel" className={iconButton}>
            <PanelRightClose className="size-3.5" strokeWidth={1.75} />
          </button>
        </span>
      </div>

      <div className="shrink-0 space-y-2 border-b border-line p-3">
        {targets.length > 1 && (
          <select
            value={targetId}
            onChange={(event) => {
              const next = targets.find((entry) => targetKey(entry) === event.target.value);
              setTargetId(event.target.value);
              setTaskName(next?.tasks[0]?.name ?? CUSTOM);
            }}
            aria-label="Program"
            className={selectClass}
          >
            {targets.map((entry) => (
              <option key={targetKey(entry)} value={targetKey(entry)}>
                {`${entry.name} · ${entry.kind}${entry.dir ? ` (${entry.dir})` : ""}`}
              </option>
            ))}
          </select>
        )}
        <div className="flex gap-2">
          <select
            value={task ? task.name : CUSTOM}
            onChange={(event) => {
              const value = event.target.value;
              if (value === CUSTOM && !custom) setCustom(command);
              setTaskName(value);
            }}
            aria-label="Task"
            className={selectClass}
          >
            {target?.tasks.map((entry) => (
              <option key={entry.name} value={entry.name}>
                {entry.name}
              </option>
            ))}
            <option value={CUSTOM}>Custom command…</option>
          </select>
          {running ? (
            <>
              <button
                type="button"
                onClick={() => void run()}
                title="Stop and run again"
                className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-ink/[0.12] px-2.5 text-[11.5px] text-ink/70 transition-colors duration-150 hover:border-ink/30 hover:text-ink"
              >
                <RotateCw className="size-3" strokeWidth={2} />
                Restart
              </button>
              <button
                type="button"
                onClick={() => void stop()}
                title="Stop the program"
                className="flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-ink px-3 text-[11.5px] font-medium text-app transition-colors duration-150 hover:bg-ink/90"
              >
                <Square className="size-3 fill-current" />
                Stop
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => void run()}
              disabled={!command.trim() || !target}
              className="flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-ink px-3 text-[11.5px] font-medium text-app transition-colors duration-150 hover:bg-ink/90 disabled:bg-ink/[0.08] disabled:text-ink/30"
            >
              <Play className="size-3 fill-current" />
              Run
            </button>
          )}
        </div>
        {task ? (
          <p title={task.command} className="truncate font-mono text-[10.5px] text-ink/35">
            {target?.dir ? `${target.dir}> ` : "> "}
            {task.command}
          </p>
        ) : (
          <input
            value={custom}
            onChange={(event) => setCustom(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void run();
            }}
            placeholder="e.g. cargo run -- --verbose"
            spellCheck={false}
            aria-label="Custom command"
            className="h-7 w-full min-w-0 rounded-md border border-line bg-app px-2 font-mono text-[11px] text-ink/80 placeholder:text-ink/25 focus:border-ink/25 focus:outline-none"
          />
        )}
      </div>

      {isTauri() ? (
        <div ref={host} className="min-h-0 flex-1 overflow-hidden bg-app px-2 py-1.5" />
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6">
          <p className="max-w-xs text-center text-[11.5px] leading-relaxed text-ink/35">
            Programs run in the desktop app. This browser preview has no terminal to run them in.
          </p>
        </div>
      )}
    </aside>
  );
}
