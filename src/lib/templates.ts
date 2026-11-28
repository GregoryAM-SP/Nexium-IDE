import { listen } from "@tauri-apps/api/event";
import { documentDir } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";

import { invoke, isTauri, toError } from "./tauriBridge";

export type NameRule = "folder" | "package" | "snake";

export type ProjectTemplate = {
  id: string;
  name: string;
  category: string;
  description: string;
  /** `builtin`: files shipped with the app. `generator`: the framework's own tool. */
  kind: "builtin" | "generator";
  /** Tools that must be installed to create it. */
  requires: string[];
  /** Tools needed to run it later. */
  runsWith: string[];
  typescript: boolean;
  install: boolean;
  nameRule: NameRule;
  /** The generator command for `my-app`, shown in the dialog:
   * [TypeScript + install, TypeScript, JavaScript + install, JavaScript]. */
  commands: string[];
};

export type TemplateCatalog = {
  templates: ProjectTemplate[];
  /** Which developer tools are on PATH. */
  tools: Record<string, boolean>;
};

export type ProjectChoice = {
  template: string;
  parent: string;
  name: string;
  typescript: boolean;
  install: boolean;
  git: boolean;
};

export type CreateEvent = { kind: "step" | "output"; text: string };

const PARENT_KEY = "nexium.newProject.parent";

/** Where tools come from, for the "how to install" links. */
export const TOOL_LINKS: Record<string, string> = {
  node: "https://nodejs.org/",
  npm: "https://nodejs.org/",
  npx: "https://nodejs.org/",
  python: "https://www.python.org/downloads/",
  cargo: "https://www.rust-lang.org/tools/install",
  go: "https://go.dev/dl/",
  flutter: "https://docs.flutter.dev/get-started/install",
  dotnet: "https://dotnet.microsoft.com/download",
  java: "https://adoptium.net/",
  gradle: "https://gradle.org/install/",
  cmake: "https://cmake.org/download/",
  git: "https://git-scm.com/downloads",
};

/** The template list as the browser build shows it (nothing can be created there). */
const DEMO: TemplateCatalog = {
  templates: [
    { id: "html", name: "HTML, CSS & JavaScript", category: "Web", description: "A plain static site.", kind: "builtin", requires: [], runsWith: [], typescript: false, install: false, nameRule: "folder", commands: [] },
    { id: "bootstrap", name: "Bootstrap", category: "Web", description: "A Bootstrap 5 landing page.", kind: "builtin", requires: [], runsWith: [], typescript: false, install: false, nameRule: "folder", commands: [] },
    { id: "vite-react", name: "React (Vite)", category: "Web", description: "A React app with Vite.", kind: "generator", requires: ["npm"], runsWith: ["node"], typescript: true, install: true, nameRule: "package", commands: ["npm create vite@latest my-app -- --template react-ts --no-interactive"] },
    { id: "flutter", name: "Flutter", category: "Mobile", description: "A Flutter app.", kind: "generator", requires: ["flutter"], runsWith: ["flutter"], typescript: false, install: true, nameRule: "snake", commands: ["flutter create my_app", "flutter create my_app --no-pub"] },
    { id: "blank", name: "Empty folder", category: "Other", description: "Nothing but the folder.", kind: "builtin", requires: [], runsWith: [], typescript: false, install: false, nameRule: "folder", commands: [] },
  ],
  tools: { npm: true, node: true, flutter: false, git: true },
};

export async function loadTemplates(): Promise<TemplateCatalog> {
  if (!isTauri()) {
    return DEMO;
  }

  try {
    return await invoke<TemplateCatalog>("project_templates");
  } catch (cause) {
    throw toError(cause, "The templates could not be loaded.");
  }
}

/** The folder new projects go in: the last one used, else Documents. */
export async function defaultParent(): Promise<string> {
  const saved = localStorage.getItem(PARENT_KEY);
  if (saved) {
    return saved;
  }

  if (!isTauri()) {
    return "";
  }

  try {
    return await documentDir();
  } catch {
    return "";
  }
}

export function rememberParent(parent: string) {
  localStorage.setItem(PARENT_KEY, parent);
}

export async function pickParent(current: string): Promise<string | null> {
  if (!isTauri()) {
    return null;
  }

  const selection = await open({
    directory: true,
    multiple: false,
    defaultPath: current || undefined,
    title: "Choose where to create the project",
  });

  return typeof selection === "string" ? selection : null;
}

/**
 * Creates the project and returns its folder. `onEvent` receives the steps
 * and the generator's output as they happen.
 */
export async function createProject(
  choice: ProjectChoice,
  onEvent: (event: CreateEvent) => void,
): Promise<string> {
  if (!isTauri()) {
    throw new Error("Projects can only be created in the desktop app.");
  }

  const stop = await listen<CreateEvent>("project-create", (event) => onEvent(event.payload));

  try {
    return await invoke<string>("create_project", { choice });
  } catch (cause) {
    throw toError(cause, "The project could not be created.");
  } finally {
    stop();
  }
}

export async function cancelCreateProject(): Promise<void> {
  if (isTauri()) {
    await invoke("create_project_cancel");
  }
}

/** Why `name` will not do for this template (mirrors the Rust check). */
export function nameProblem(name: string, rule: NameRule): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Give the project a name.";
  if (trimmed.length > 100) return "That name is too long.";
  if (/[<>:"/\|?*\u0000-\u001f]/.test(trimmed) || /^\.|[. ]$/.test(trimmed)) {
    return 'A folder name cannot contain < > : " / \ | ? * or start or end with a dot.';
  }
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(trimmed)) {
    return `${trimmed} is a reserved name on Windows.`;
  }
  if (rule === "package" && !/^[a-z0-9][a-z0-9._-]*$/.test(trimmed)) {
    return "Use lowercase letters, digits and dashes for this template (for example my-app).";
  }
  if (rule === "snake" && !/^[a-z][a-z0-9_]*$/.test(trimmed)) {
    return "Flutter needs lowercase letters, digits and underscores, starting with a letter (for example my_app).";
  }
  return null;
}

/** The command a generator template will run with these options. */
export function generatorCommand(
  template: ProjectTemplate,
  name: string,
  typescript: boolean,
  install: boolean,
): string | null {
  const { commands } = template;
  if (commands.length === 0) return null;
  const index = (template.typescript && !typescript ? 2 : 0) + (template.install && !install ? 1 : 0);
  const command = commands[Math.min(index, commands.length - 1)];
  // Flutter's sample name is my_app; the others use my-app.
  return command.replace(/\bmy[-_]app\b/g, name || "my-app");
}

/** A name in the shape the template wants, from whatever was typed. */
export function fitName(name: string, rule: NameRule): string {
  if (rule === "folder") return name;
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, rule === "snake" ? "_" : "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  if (rule === "snake" && /^\d/.test(slug)) return `app_${slug}`;
  return slug;
}
