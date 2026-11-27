// In-app updates. The desktop shell asks GitHub for the latest release's
// `latest.json` (see `plugins.updater` in tauri.conf.json), downloads a newer
// version quietly in the background, and installs it when the window closes —
// or straight away from "Restart now". Every download is checked against the
// public key in tauri.conf.json, so only builds signed by the release workflow
// install, and only from the same kind of installer this copy came from (see
// updateTarget.ts).
import { getCurrentWindow } from "@tauri-apps/api/window";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import type { Update } from "@tauri-apps/plugin-updater";

import { invoke, isTauri } from "./tauriBridge";
import { updateTargetProblem } from "./updateTarget";
import type { InstallKind } from "./updateTarget";

export type UpdateState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "current"; checkedAt: number }
  | { phase: "downloading"; version: string; received: number; total: number | null }
  | { phase: "ready"; version: string; notes?: string }
  | { phase: "installing"; version: string }
  | { phase: "error"; message: string };

/** First check a little after launch, so startup stays quick; then every 6 h. */
const FIRST_CHECK_MS = 8_000;
const RECHECK_MS = 6 * 60 * 60 * 1000;

let state: UpdateState = { phase: "idle" };
let pending: Update | null = null;
const listeners = new Set<(state: UpdateState) => void>();

function set(next: UpdateState) {
  state = next;
  listeners.forEach((listener) => listener(next));
}

export function updateState(): UpdateState {
  return state;
}

export function onUpdateState(listener: (state: UpdateState) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const busy = () =>
  ["checking", "downloading", "installing", "ready"].includes(state.phase);

/**
 * Looks for a newer release and, if there is one, downloads it. Returns the
 * state it ends in so a manual "Check for updates" can report it.
 */
export async function checkForUpdates(): Promise<UpdateState> {
  if (!isTauri()) {
    set({ phase: "error", message: "Updates are only available in the desktop app." });
    return state;
  }

  if (busy()) {
    return state;
  }

  set({ phase: "checking" });

  let update: Update | null;

  try {
    update = await check();
  } catch (cause) {
    set({ phase: "error", message: describe(cause, "Could not check for updates.") });
    return state;
  }

  if (!update) {
    set({ phase: "current", checkedAt: Date.now() });
    return state;
  }

  const version = update.version;

  // Checked before a single byte is downloaded: the wrong installer type would
  // install a second copy instead of updating this one.
  let problem: string | null;

  try {
    const kind = await invoke<InstallKind>("install_kind");
    problem = updateTargetProblem(update.rawJson, version, kind);
  } catch (cause) {
    problem = describe(cause, "Could not tell how this copy was installed.");
  }

  if (problem) {
    void update.close();
    set({ phase: "error", message: problem });
    return state;
  }

  let received = 0;
  let total: number | null = null;
  set({ phase: "downloading", version, received, total });

  try {
    await update.download((event) => {
      if (event.event === "Started") {
        total = event.data.contentLength ?? null;
      } else if (event.event === "Progress") {
        received += event.data.chunkLength;
      }

      set({ phase: "downloading", version, received, total });
    });
  } catch (cause) {
    void update.close();
    set({ phase: "error", message: describe(cause, "The update could not be downloaded.") });
    return state;
  }

  pending = update;
  set({ phase: "ready", version, notes: update.body });
  return state;
}

/**
 * Installs the downloaded update now and starts the new version. On Windows
 * the installer closes this process itself; elsewhere the app relaunches.
 */
export async function installNow(): Promise<void> {
  if (!pending) {
    return;
  }

  set({ phase: "installing", version: pending.version });

  try {
    await pending.install({ restartAfterInstall: true });
    await relaunch();
  } catch (cause) {
    set({ phase: "error", message: describe(cause, "The update could not be installed.") });
  }
}

/**
 * Checks on launch and every few hours, and installs a downloaded update when
 * the window is closed. Returns a cleanup function.
 */
export function startAutoUpdates(): () => void {
  if (!isTauri() || import.meta.env.DEV) {
    return () => {};
  }

  const first = window.setTimeout(() => void checkForUpdates(), FIRST_CHECK_MS);
  const again = window.setInterval(() => void checkForUpdates(), RECHECK_MS);

  let closing = false;
  const appWindow = getCurrentWindow();
  const unlisten = appWindow.onCloseRequested(async (event) => {
    if (!pending || closing) {
      return;
    }

    // Hold the close, install, then let the window go. Windows hands over to
    // the installer (which ends this process); Linux replaces the AppImage.
    event.preventDefault();
    closing = true;
    set({ phase: "installing", version: pending.version });

    try {
      await pending.install({ restartAfterInstall: false });
    } catch (cause) {
      console.error("The update could not be installed on close:", cause);
    }

    await appWindow.destroy();
  });

  return () => {
    window.clearTimeout(first);
    window.clearInterval(again);
    void unlisten.then((stop) => stop());
  };
}

function describe(cause: unknown, fallback: string): string {
  const text =
    cause instanceof Error
      ? cause.message
      : typeof cause === "string"
        ? cause
        : "";

  return text.trim() ? `${fallback} ${text.trim()}` : fallback;
}
