import {
  AlertTriangle,
  ExternalLink,
  FileCode,
  Globe,
  Laptop,
  LoaderCircle,
  Monitor,
  PanelRightClose,
  Play,
  RotateCw,
  ScrollText,
  Smartphone,
  Square,
  Maximize2,
  RectangleHorizontal,
  Tablet,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

import DeviceFrame, { DEVICES } from "./DeviceFrame";
import type { DeviceId } from "./DeviceFrame";
import { openInBrowser, pageUrl } from "../lib/web";
import type { WebApp } from "../lib/web";
import type { WebPreview } from "../lib/useWebPreview";

type WebPreviewPanelProps = {
  preview: WebPreview;
  /** The file open in the editor, offered as the live server's page. */
  activePath: string;
  onInstall: (app: WebApp) => void;
  onHide: () => void;
};

type Mode = "dev" | "live";
/** A device frame, or "fit" for the page laid out at the panel's own size. */
type Viewport = DeviceId | "fit";

const VIEW_KEY = "nexium.preview.device";
const WIDTH_KEY = "nexium.preview.width";
const MIN_WIDTH = 340;

const VIEWPORTS: { id: Viewport; label: string; icon: LucideIcon }[] = [
  { id: "desktop", label: `Desktop (${DEVICES.desktop.width}×${DEVICES.desktop.height})`, icon: Monitor },
  { id: "laptop", label: `Laptop (${DEVICES.laptop.width}×${DEVICES.laptop.height})`, icon: Laptop },
  { id: "tablet", label: `Tablet (${DEVICES.tablet.width}×${DEVICES.tablet.height})`, icon: Tablet },
  { id: "mobile", label: `Mobile (${DEVICES.mobile.width}×${DEVICES.mobile.height})`, icon: Smartphone },
  { id: "fit", label: "Fit to the panel", icon: Maximize2 },
];

function loadViewport(): Viewport {
  const stored = localStorage.getItem(VIEW_KEY);
  return VIEWPORTS.some((entry) => entry.id === stored) ? (stored as Viewport) : "desktop";
}

const iconButton =
  "flex size-6 shrink-0 items-center justify-center rounded-md text-ink/35 transition-colors duration-150 hover:bg-ink/[0.06] hover:text-ink disabled:text-ink/15";
const selectClass =
  "h-7 w-full min-w-0 rounded-md border border-line bg-app px-2 pr-6 text-[11.5px] text-ink/80 focus:border-ink/25 focus:outline-none";
const primaryButton =
  "flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-md bg-ink px-3 text-[11.5px] font-medium text-app transition-colors duration-150 hover:bg-ink/90 disabled:bg-ink/[0.08] disabled:text-ink/30";

function appLabel(app: WebApp): string {
  const where = app.dir ? app.dir : "root";
  return app.framework ? `${app.name} · ${app.framework} (${where})` : `${app.name} (${where})`;
}

function loadWidth(): number {
  const stored = Number(localStorage.getItem(WIDTH_KEY));
  return Number.isFinite(stored) && stored >= MIN_WIDTH ? stored : 520;
}

export default function WebPreviewPanel({
  preview,
  activePath,
  onInstall,
  onHide,
}: WebPreviewPanelProps) {
  const { info, dev, live, logs, exited, busy, error } = preview;
  const apps = info?.apps ?? [];
  const pages = info?.pages ?? [];

  // A project with a package.json always previews through its own dev
  // server; the built-in live server is only for plain HTML folders.
  const mode: Mode = apps.length > 0 ? "dev" : "live";
  const [externalError, setExternalError] = useState<string | null>(null);
  const [appIndex, setAppIndex] = useState(0);
  const app = apps[Math.min(appIndex, apps.length - 1)] ?? null;
  const [script, setScript] = useState(
    () => app?.preferred ?? app?.scripts[0] ?? "",
  );
  const [page, setPage] = useState("");
  const [address, setAddress] = useState("");
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [viewport, setViewport] = useState<Viewport>(loadViewport);
  const [landscape, setLandscape] = useState(false);

  const chooseViewport = (next: Viewport) => {
    setViewport(next);
    localStorage.setItem(VIEW_KEY, next);
  };
  const [logsOpen, setLogsOpen] = useState(false);
  const [width, setWidth] = useState(loadWidth);
  const [dragging, setDragging] = useState(false);
  const logEnd = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    setScript(app?.preferred ?? app?.scripts[0] ?? "");
  }, [app?.dir]);

  const activeHtml = /\.html?$/i.test(activePath) ? activePath : "";

  useEffect(() => {
    if (!page || !pages.includes(page)) {
      setPage(activeHtml || pages[0] || "");
    }
  }, [pages.join("|")]);

  // What the frame shows follows whichever server the mode points at.
  const target = useMemo(() => {
    if (mode === "dev") {
      return dev?.url ?? null;
    }
    return live && page ? pageUrl(live, page) : live;
  }, [mode, dev?.url, live, page]);

  useEffect(() => {
    setFrameUrl(target);
    setAddress(target ?? "");
  }, [target]);

  // The log opens by itself while the server has not printed its address
  // yet, and when it stopped on its own, since that is where the reason is.
  useEffect(() => {
    if (mode === "dev" && ((dev && !dev.url) || exited)) {
      setLogsOpen(true);
    }
  }, [mode, dev?.url, dev !== null, exited]);

  useEffect(() => {
    if (logsOpen) {
      logEnd.current?.scrollIntoView({ block: "end" });
    }
  }, [logs.length, logsOpen]);

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    let latest = startWidth;
    setDragging(true);

    const move = (moveEvent: PointerEvent) => {
      const max = Math.max(MIN_WIDTH, window.innerWidth * 0.75);
      latest = Math.min(max, Math.max(MIN_WIDTH, startWidth + startX - moveEvent.clientX));
      setWidth(latest);
    };
    const up = () => {
      setDragging(false);
      localStorage.setItem(WIDTH_KEY, String(Math.round(latest)));
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const running = mode === "dev" ? dev !== null : live !== null;
  const handheld = viewport === "tablet" || viewport === "mobile";
  const openExternal = (url: string) => {
    setExternalError(null);
    void openInBrowser(url).catch((cause: Error) => setExternalError(cause.message));
  };

  const navigate = () => {
    const next = address.trim();
    if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(next)) {
      setFrameUrl(next);
      setNonce((current) => current + 1);
    } else {
      setAddress(frameUrl ?? "");
    }
  };

  let body;

  if (!info?.detected) {
    body = (
      <div className="px-3 py-4">
        <div className="rounded-xl border border-line bg-ink/[0.015] p-3">
          <p className="text-[11.5px] text-ink/65">Nothing to preview</p>
          <p className="mt-1 text-[10.5px] leading-relaxed text-ink/30">
            Add an HTML file, or a package.json with a dev script (Vite,
            React, Next.js and others), and it shows up here.
          </p>
        </div>
      </div>
    );
  } else if (!running) {
    body = (
      <div className="flex flex-col gap-3 px-3 py-4">
        {mode === "dev" && app ? (
          <div className="rounded-xl border border-line bg-ink/[0.015] p-3">
            <p className="text-[11.5px] text-ink/70">Run the dev server</p>
            <p className="mt-1 text-[10.5px] leading-relaxed text-ink/30">
              Starts the project's own server and shows it here, with hot
              reload as your tooling provides it.
            </p>

            <div className="mt-3 space-y-2">
              {apps.length > 1 && (
                <select
                  value={appIndex}
                  onChange={(event) => setAppIndex(Number(event.target.value))}
                  className={selectClass}
                  aria-label="App"
                >
                  {apps.map((entry, index) => (
                    <option key={entry.dir || "root"} value={index}>
                      {appLabel(entry)}
                    </option>
                  ))}
                </select>
              )}
              <div className="flex gap-2">
                <select
                  value={script}
                  onChange={(event) => setScript(event.target.value)}
                  className={selectClass}
                  aria-label="Script"
                >
                  {app.scripts.map((name) => (
                    <option key={name} value={name}>
                      {`${app.packageManager} ${app.packageManager === "yarn" ? "" : "run "}${name}`}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => void preview.startDev(app.dir, script)}
                  disabled={busy || !script}
                  className={primaryButton}
                >
                  {busy ? <LoaderCircle className="size-3 animate-spin" /> : <Play className="size-3" strokeWidth={2} />}
                  Start
                </button>
              </div>
            </div>

            {!app.installed && (
              <div className="mt-3 flex items-start gap-2 rounded-lg border border-ink/10 bg-ink/[0.03] px-2.5 py-2">
                <AlertTriangle className="mt-0.5 size-3 shrink-0 text-ink/45" strokeWidth={1.75} />
                <div className="min-w-0 flex-1 text-[10.5px] leading-relaxed text-ink/50">
                  Dependencies are not installed yet.
                  <button
                    type="button"
                    onClick={() => onInstall(app)}
                    className="ml-1 text-ink/80 underline decoration-ink/30 underline-offset-2 hover:decoration-ink"
                  >
                    Run {app.packageManager} install
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="rounded-xl border border-line bg-ink/[0.015] p-3">
            <p className="text-[11.5px] text-ink/70">Start the live server</p>
            <p className="mt-1 text-[10.5px] leading-relaxed text-ink/30">
              Serves this folder and reloads the page whenever you save HTML,
              CSS, JavaScript or images it uses. Works with Bootstrap and
              other CDN libraries.
            </p>
            <div className="mt-3 flex gap-2">
              <select
                value={page}
                onChange={(event) => setPage(event.target.value)}
                className={selectClass}
                aria-label="Page"
              >
                {pages.map((entry) => (
                  <option key={entry} value={entry}>
                    {entry}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => void preview.startLive()}
                disabled={busy || pages.length === 0}
                className={primaryButton}
              >
                {busy ? <LoaderCircle className="size-3 animate-spin" /> : <Zap className="size-3" strokeWidth={2} />}
                Go live
              </button>
            </div>
          </div>
        )}

        {mode === "dev" && exited && logs.length > 0 && (
          <div className="rounded-lg border border-line bg-app">
            <p className="border-b border-line px-2.5 py-1.5 text-[10px] text-ink/45">
              The dev server stopped
              {exited.code !== null ? ` (exit code ${exited.code})` : ""}. Last output:
            </p>
            <pre className="max-h-48 overflow-auto px-2.5 py-2 font-mono text-[10px] leading-relaxed whitespace-pre-wrap text-ink/55">
              {logs.slice(-30).join("\n")}
            </pre>
          </div>
        )}
      </div>
    );
  } else {
    body = (
      <>
        <div className="flex shrink-0 items-center gap-1.5 border-b border-line px-2 py-1.5">
          <span
            title={mode === "dev" ? `Dev server: ${dev?.script}` : "Live server"}
            className={`size-1.5 shrink-0 rounded-full ${frameUrl ? "bg-emerald-400/80" : "animate-pulse bg-amber-300/80"}`}
          />
          {mode === "live" && pages.length > 0 ? (
            <select
              value={page}
              onChange={(event) => setPage(event.target.value)}
              className={`${selectClass} h-6 font-mono text-[10.5px]`}
              aria-label="Page"
            >
              {pages.map((entry) => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
            </select>
          ) : (
            <input
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  navigate();
                }
              }}
              placeholder="Waiting for the server's address…"
              spellCheck={false}
              className="h-6 min-w-0 flex-1 rounded-md border border-line bg-app px-2 font-mono text-[10.5px] text-ink/75 placeholder:text-ink/25 focus:border-ink/25 focus:outline-none"
            />
          )}
          {mode === "live" && activeHtml && activeHtml !== page && pages.includes(activeHtml) && (
            <button
              type="button"
              onClick={() => setPage(activeHtml)}
              title={`Show ${activeHtml}`}
              className={iconButton}
            >
              <FileCode className="size-3.5" strokeWidth={1.75} />
            </button>
          )}
          {mode === "dev" && (
            <button
              type="button"
              onClick={() => setLogsOpen((open) => !open)}
              aria-pressed={logsOpen}
              title={logsOpen ? "Hide server output" : "Show server output"}
              className={`${iconButton} ${logsOpen ? "bg-ink/[0.06] text-ink/75" : ""}`}
            >
              <ScrollText className="size-3.5" strokeWidth={1.75} />
            </button>
          )}
          {frameUrl && (
            <button
              type="button"
              onClick={() => openExternal(frameUrl)}
              title={`Open ${frameUrl} in your default browser`}
              className="flex h-6 shrink-0 items-center gap-1.5 rounded-md border border-ink/10 bg-ink/[0.03] px-2 text-[11px] text-ink/65 transition-colors duration-150 hover:border-ink/20 hover:bg-ink/[0.06] hover:text-ink"
            >
              <ExternalLink className="size-3" strokeWidth={1.75} />
              Open in browser
            </button>
          )}
          <button
            type="button"
            onClick={() => void (mode === "dev" ? preview.stopDev() : preview.stopLive())}
            disabled={busy}
            title={mode === "dev" ? "Stop the dev server" : "Stop the live server"}
            className={iconButton}
          >
            <Square className="size-3" strokeWidth={2} />
          </button>
        </div>

        <div className="relative flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 flex-col bg-ink/[0.03]">
            {frameUrl && viewport !== "fit" ? (
              <DeviceFrame
                device={viewport}
                landscape={landscape}
                url={frameUrl}
                nonce={nonce}
                interactive={!dragging}
                onReload={() => setNonce((current) => current + 1)}
              />
            ) : frameUrl ? (
              <iframe
                key={`${frameUrl}#${nonce}`}
                src={frameUrl}
                title="Website preview"
                // Everything a page needs, but it can never navigate the IDE.
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
                style={{ pointerEvents: dragging ? "none" : undefined }}
                className="h-full w-full border-0 bg-white"
              />
            ) : (
              <div className="flex flex-col items-center justify-center gap-2 px-6 text-center">
                <LoaderCircle className="size-4 animate-spin text-ink/30" />
                <p className="text-[11px] text-ink/40">
                  Starting {dev?.script}… the preview opens when the server
                  prints its address.
                </p>
              </div>
            )}
          </div>

          {mode === "dev" && logsOpen && (
            <div className="flex h-[38%] min-h-[110px] shrink-0 flex-col border-t border-line bg-app">
              <p className="shrink-0 border-b border-line px-2.5 py-1 font-mono text-[9px] uppercase tracking-[0.16em] text-ink/30">
                Server output
              </p>
              <pre className="min-h-0 flex-1 overflow-auto px-2.5 py-1.5 font-mono text-[10px] leading-relaxed whitespace-pre-wrap text-ink/55">
                {logs.join("\n")}
                <span ref={logEnd} />
              </pre>
            </div>
          )}
        </div>
      </>
    );
  }

  return (
    <aside
      aria-label="Website preview"
      // A small window keeps room for the editor whatever width was saved.
      style={{ width, maxWidth: "calc(100vw - 420px)" }}
      className="relative flex shrink-0 flex-col border-l border-line bg-surface"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the preview"
        onPointerDown={startResize}
        className={`absolute top-0 bottom-0 -left-1 z-10 w-2 cursor-col-resize transition-colors duration-150 hover:bg-ink/10 ${dragging ? "bg-ink/15" : ""}`}
      />

      <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-line bg-gradient-to-b from-ink/[0.02] to-transparent px-3">
        <span className="flex min-w-0 items-center gap-2 text-[10px] font-medium uppercase tracking-[0.18em] text-ink/45">
          <Globe className="size-3.5 shrink-0 text-ink/45" strokeWidth={1.75} />
          <span className="truncate">Preview</span>
        </span>
        <span className="flex shrink-0 items-center gap-0.5">
          {running && frameUrl && (
            <>
              {VIEWPORTS.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => chooseViewport(entry.id)}
                  aria-pressed={viewport === entry.id}
                  title={entry.label}
                  className={`${iconButton} ${viewport === entry.id ? "bg-ink/[0.06] text-ink/75" : ""}`}
                >
                  <entry.icon className="size-3.5" strokeWidth={1.75} />
                </button>
              ))}
              {handheld && (
                <button
                  type="button"
                  onClick={() => setLandscape((current) => !current)}
                  aria-pressed={landscape}
                  title={landscape ? "Turn upright" : "Turn sideways"}
                  className={`${iconButton} ${landscape ? "bg-ink/[0.06] text-ink/75" : ""}`}
                >
                  <RectangleHorizontal className="size-3.5" strokeWidth={1.75} />
                </button>
              )}
              <span aria-hidden className="mx-1 h-4 w-px bg-ink/[0.08]" />
              <button
                type="button"
                onClick={() => setNonce((current) => current + 1)}
                title="Reload"
                className={iconButton}
              >
                <RotateCw className="size-3.5" strokeWidth={1.75} />
              </button>
            </>
          )}
          <button
            type="button"
            onClick={onHide}
            aria-label="Hide preview"
            title="Hide preview (servers keep running)"
            className={iconButton}
          >
            <PanelRightClose className="size-3.5" strokeWidth={1.75} />
          </button>
        </span>
      </div>

      {(error || externalError) && (
        <p className="flex shrink-0 items-start gap-1.5 border-b border-line px-3 py-1.5 text-[10.5px] leading-relaxed text-red-300/80">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" strokeWidth={1.75} />
          {error ?? externalError}
        </p>
      )}

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{body}</div>
    </aside>
  );
}
