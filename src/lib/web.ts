import { invoke, isTauri, toError } from "./tauriBridge";

/** A package.json script that starts a server the preview can show. */
export type ServerScript = {
  name: string;
  command: string;
  /** The port it should listen on, when that can be told in advance. */
  port: number | null;
};

export type WebApp = {
  /** Folder relative to the workspace root, empty for the root. */
  dir: string;
  name: string;
  framework: string;
  /** Every script in package.json. */
  scripts: string[];
  /** The scripts that start a server, the likeliest first. */
  servers: ServerScript[];
  preferred: string | null;
  /** A command to offer when no script starts a server, e.g. `npx vite`. */
  fallback: string | null;
  packageManager: string;
  /** node_modules exists, so the dev server can start. */
  installed: boolean;
  /** It can run on the web (a Flutter app needs a web/ folder, Expo needs react-native-web). */
  webSupport: boolean;
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
  /** The command is known to start a web server, so a preview should come. */
  expectsPreview: boolean;
  /** The server's page, which refuses to be shown in a frame. */
  blockedUrl: string | null;
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
      servers: [
        { name: "dev", command: "vite", port: 5173 },
        { name: "preview", command: "vite preview", port: 4173 },
      ],
      preferred: "dev",
      fallback: null,
      packageManager: "npm",
      installed: true,
      webSupport: true,
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

/**
 * Starts a package.json `script` in `dir`, or the user's own `command` line
 * in that folder when one is given.
 */
export async function startDevServer(
  dir: string,
  script: string,
  command: string | null = null,
  /** Runs the script with this manager instead of the project's own. */
  manager: string | null = null,
): Promise<DevStatus> {
  if (!isTauri()) {
    // The page itself is a Vite dev server, so it can stand in for one.
    return {
      running: true,
      dir,
      script: command ?? script,
      url: window.location.origin,
      expectsPreview: true,
      blockedUrl: null,
    };
  }

  try {
    return await invoke<DevStatus>("web_start_dev", { dir, script, command, manager });
  } catch (cause) {
    throw toError(cause, "The dev server could not start.");
  }
}

/** Sends keys to the running server, e.g. "r" for Flutter's hot reload. */
export async function sendDevInput(text: string): Promise<void> {
  if (isTauri()) {
    await invoke("web_dev_input", { text });
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

/** How a script is run, e.g. `bun run dev` or `yarn dev`. */
export function scriptCommand(
  app: WebApp,
  script: string,
  manager: string = app.packageManager,
): string {
  return manager === "yarn" ? `yarn ${script}` : `${manager} run ${script}`;
}

/** The command that installs an app's dependencies, for the terminal. */
export function installCommand(app: WebApp, windows: boolean): string {
  const install =
    app.packageManager === "flutter"
      ? "flutter pub get"
      : app.packageManager === "python"
        ? windows
          ? "python -m venv .venv; .venv\\Scripts\\python -m pip install -r requirements.txt"
          : "python3 -m venv .venv && .venv/bin/python -m pip install -r requirements.txt"
        : `${app.packageManager} install`;

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
  return /(^|\/)(package\.json|pubspec\.yaml)$/.test(path) || isHtmlPath(path);
}

/** Encodes a workspace path for a URL, keeping the slashes. */
export function pageUrl(origin: string, page: string): string {
  return `${origin}/${page.split("/").map(encodeURIComponent).join("/")}`;
}
