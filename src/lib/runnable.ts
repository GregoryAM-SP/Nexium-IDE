import { invoke, isTauri, toError } from "./tauriBridge";

export type RunTask = { name: string; command: string };

/** A program in the workspace the Run panel can start. */
export type Runnable = {
  /** Folder relative to the workspace root, empty for the root. */
  dir: string;
  name: string;
  /** "Rust", "Go", ".NET", "Python", "C++ (CMake)", "Node.js", "Flutter", "Dart". */
  kind: string;
  /** The first is the default. */
  tasks: RunTask[];
};

/** What the panel last ran in a project, restored when it is opened again. */
export type RunChoice = {
  /** `${dir}|${kind}` of the chosen runnable. */
  target: string;
  /** A task's name, or "" for the custom command. */
  task: string;
  /** The typed command, when `task` is "". */
  custom: string;
};

const DEMO: Runnable[] = [
  {
    dir: "",
    name: "hello",
    kind: "Rust",
    tasks: [
      { name: "Run", command: "cargo run" },
      { name: "Test", command: "cargo test" },
    ],
  },
];

export async function loadRunTargets(): Promise<Runnable[]> {
  if (!isTauri()) return DEMO;
  try {
    return await invoke<Runnable[]>("run_targets");
  } catch (cause) {
    throw toError(cause, "The project could not be checked for programs to run.");
  }
}

export const targetKey = (runnable: Runnable) => `${runnable.dir}|${runnable.kind}`;

const KEY = "nexium.runPanel:";

export function loadRunChoice(root: string): RunChoice | null {
  try {
    const value = JSON.parse(localStorage.getItem(KEY + root) ?? "null") as RunChoice | null;
    return value && typeof value.target === "string" ? value : null;
  } catch {
    return null;
  }
}

export function saveRunChoice(root: string, choice: RunChoice) {
  if (root) localStorage.setItem(KEY + root, JSON.stringify(choice));
}
