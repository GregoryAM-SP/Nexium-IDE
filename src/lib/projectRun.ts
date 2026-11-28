import { scriptCommand } from "./web";
import type { WebApp } from "./web";

/**
 * How each app in a project runs for the preview. Kept per machine (in local
 * storage, by project folder), so nothing is written into the project.
 */
export type FlutterRun = {
  kind: "flutter";
  mode: "debug" | "profile" | "release";
  port: number;
  /** Build with WebAssembly (`--wasm`) instead of JavaScript. */
  wasm: boolean;
  /** The entry point, `lib/main.dart` by default. */
  target: string;
  /** `KEY=value` pairs, one per line, passed as `--dart-define`. */
  defines: string;
  /** Saving a .dart file hot-reloads the running app. */
  hotReloadOnSave: boolean;
};

export type ExpoRun = {
  kind: "expo";
  port: number;
  /** Start with Metro's cache cleared (`--clear`). */
  clear: boolean;
};

export type NodeRun = {
  kind: "node";
  /** The package.json script to run; empty for the detected default. */
  script: string;
  /** A port to ask for; empty for the tool's own. */
  port: string;
};

export type PythonRun = {
  kind: "python";
  /** Empty for the framework's own (Flask 5000, FastAPI and Django 8000). */
  port: string;
  /** Restart the server when a file changes. */
  reload: boolean;
};

export type AppRun = FlutterRun | ExpoRun | NodeRun | PythonRun;

const PYTHON_FRAMEWORKS = ["Flask", "FastAPI", "Django"];

/** Run settings of one project, by app folder ("" for the root). */
export type ProjectRun = Record<string, AppRun>;

const KEY = "nexium.run:";

export function defaultRun(app: WebApp): AppRun {
  if (app.framework === "Flutter") {
    return { kind: "flutter", mode: "debug", port: 8080, wasm: false, target: "lib/main.dart", defines: "", hotReloadOnSave: true };
  }
  if (app.framework === "Expo") {
    return { kind: "expo", port: 8081, clear: false };
  }
  if (PYTHON_FRAMEWORKS.includes(app.framework)) {
    return { kind: "python", port: "", reload: true };
  }
  return { kind: "node", script: "", port: "" };
}

export function loadProjectRun(root: string): ProjectRun {
  if (!root) return {};
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY + root) ?? "{}") as unknown;
    return parsed && typeof parsed === "object" ? (parsed as ProjectRun) : {};
  } catch {
    return {};
  }
}

export function saveProjectRun(root: string, run: ProjectRun) {
  if (root) localStorage.setItem(KEY + root, JSON.stringify(run));
}

/** The app's settings, with defaults for anything not saved. */
export function runFor(run: ProjectRun, app: WebApp): AppRun {
  const fallback = defaultRun(app);
  const saved = run[app.dir];
  return saved && saved.kind === fallback.kind ? ({ ...fallback, ...saved } as AppRun) : fallback;
}

/** Quotes an argument for the shell when it needs it. */
function arg(value: string): string {
  return /^[\w./:=@+-]+$/.test(value) ? value : `"${value.replace(/"/g, '\\"')}"`;
}

/**
 * The command that serves the app for the preview with these settings, or
 * null when the panel's own choice (the detected script) should be used.
 */
export function runCommand(app: WebApp, settings: AppRun): string | null {
  switch (settings.kind) {
    case "flutter": {
      const parts = ["flutter run -d web-server --web-hostname 127.0.0.1", `--web-port ${settings.port || 8080}`];
      if (settings.mode !== "debug") parts.push(`--${settings.mode}`);
      if (settings.wasm) parts.push("--wasm");
      const target = settings.target.trim();
      if (target && target !== "lib/main.dart") parts.push(`-t ${arg(target)}`);
      for (const line of settings.defines.split("\n")) {
        const define = line.trim();
        if (define.includes("=")) parts.push(`--dart-define=${arg(define)}`);
      }
      return parts.join(" ");
    }
    case "expo":
      return `npx expo start --web --port ${settings.port || 8081}${settings.clear ? " --clear" : ""}`;
    case "python": {
      let command = app.fallback ?? "";
      const port = settings.port.trim();
      if (app.framework === "Django") {
        if (port) command = command.replace(/(runserver \S*:)\d+/, `$1${port}`);
        if (!settings.reload) command += " --noreload";
      } else {
        if (port) command = command.replace(/--port \d+/, `--port ${port}`);
        if (!settings.reload) command = command.replace(app.framework === "Flask" ? " --debug" : " --reload", "");
      }
      return command || null;
    }
    case "node": {
      const port = settings.port.trim();
      if (!settings.script && !port) return null;
      const script = settings.script || app.preferred || "dev";
      const base = scriptCommand(app, script);
      if (!port) return base;
      // npm passes arguments to the script only after `--`.
      return app.packageManager === "npm" ? `${base} -- --port ${port}` : `${base} --port ${port}`;
    }
  }
}

/** Runs `command` in an app's folder, as a line for the terminal. */
export function commandIn(dir: string, command: string, windows: boolean): string {
  if (!dir) return command;
  const quoted = windows ? `'${dir.replace(/'/g, "''")}'` : `'${dir.replace(/'/g, `'\\''`)}'`;
  return windows ? `Push-Location ${quoted}; ${command}; Pop-Location` : `(cd ${quoted} && ${command})`;
}

/** What turns on web support for an app that lacks it. */
export function webSupportCommand(app: WebApp): string | null {
  if (app.framework === "Flutter") return "flutter create . --platforms web";
  if (app.framework === "Expo") return "npx expo install react-dom react-native-web @expo/metro-runtime";
  return null;
}

const WINDOWS = typeof navigator !== "undefined" && navigator.userAgent.includes("Windows");

/** The command that installs an app's dependencies. */
export function installFor(app: WebApp, windows: boolean = WINDOWS): string {
  if (app.packageManager === "flutter") return "flutter pub get";
  if (app.packageManager === "python") {
    // A virtual environment in the project, with its requirements.
    return windows
      ? "python -m venv .venv; .venv\\Scripts\\python -m pip install -r requirements.txt"
      : "python3 -m venv .venv && .venv/bin/python -m pip install -r requirements.txt";
  }
  return `${app.packageManager} install`;
}
