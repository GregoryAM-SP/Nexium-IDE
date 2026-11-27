import { invoke, isTauri, toError } from "./tauriBridge";

export type WebApp = {
  /** Folder relative to the workspace root, empty for the root. */
  dir: string;
  name: string;
  framework: string;
  scripts: string[];
  preferred: string | null;
  packageManager: string;
  /** node_modules exists, so the dev server can start. */
  installed: boolean;
};

export type WebInfo = {
  detected: boolean;
  apps: WebApp[];
  /** HTML files, the likeliest start page first. */
  pages: string[];
};

export type DevStatus = {
  running: boolean;
  dir: string;
  script: string;
  url: string | null;
};

export type WebStatus = {
  dev: DevStatus | null;
  /** The live server's origin, e.g. http://127.0.0.1:5500. */
  live: string | null;
  logs: string[];
};

/** The browser build cannot start processes; it previews the sample page. */
const demoInfo: WebInfo = {
  detected: true,
  apps: [
    {
      dir: "",
      name: "nexium-studio",
      framework: "Vite",
      scripts: ["dev", "build", "preview"],
      preferred: "dev",
      packageManager: "npm",
      installed: true,
    },
  ],
  pages: ["index.html"],
};

export async function detectWeb(): Promise<WebInfo> {
  if (!isTauri()) {
    return demoInfo;
  }

  try {
    return await invoke<WebInfo>("web_detect");
  } catch (cause) {
    throw toError(cause, "The project could not be checked for a website.");
  }
}

export async function webStatus(): Promise<WebStatus> {
  if (!isTauri()) {
    return { dev: null, live: null, logs: [] };
  }

  return invoke<WebStatus>("web_status");
}

export async function startDevServer(
  dir: string,
  script: string,
): Promise<DevStatus> {
  if (!isTauri()) {
    // The page itself is a Vite dev server, so it can stand in for one.
    return { running: true, dir, script, url: window.location.origin };
  }

  try {
    return await invoke<DevStatus>("web_start_dev", { dir, script });
  } catch (cause) {
    throw toError(cause, "The dev server could not start.");
  }
}

export async function stopDevServer(): Promise<void> {
  if (isTauri()) {
    await invoke("web_stop_dev");
  }
}

export async function startLiveServer(): Promise<string> {
  if (!isTauri()) {
    return window.location.origin;
  }

  try {
    return await invoke<string>("web_start_live");
  } catch (cause) {
    throw toError(cause, "The live server could not start.");
  }
}

export async function stopLiveServer(): Promise<void> {
  if (isTauri()) {
    await invoke("web_stop_live");
  }
}

export async function openInBrowser(url: string): Promise<void> {
  if (!isTauri()) {
    window.open(url, "_blank", "noopener");
    return;
  }

  try {
    await invoke("web_open_external", { url });
  } catch (cause) {
    throw toError(cause, "The browser could not be opened.");
  }
}

/** The command that installs an app's dependencies, for the terminal. */
export function installCommand(app: WebApp, windows: boolean): string {
  const install = `${app.packageManager} install`;

  if (!app.dir) {
    return install;
  }

  const quoted = windows
    ? `'${app.dir.replace(/'/g, "''")}'`
    : `'${app.dir.replace(/'/g, `'\\''`)}'`;

  return windows
    ? `Push-Location ${quoted}; ${install}; Pop-Location`
    : `(cd ${quoted} && ${install})`;
}

export function isHtmlPath(path: string): boolean {
  return /\.html?$/i.test(path);
}

/** Workspace files whose change can add or remove an app or page. */
export function affectsWebDetection(path: string): boolean {
  return /(^|\/)package\.json$/.test(path) || isHtmlPath(path);
}

/** Encodes a workspace path for a URL, keeping the slashes. */
export function pageUrl(origin: string, page: string): string {
  return `${origin}/${page.split("/").map(encodeURIComponent).join("/")}`;
}
