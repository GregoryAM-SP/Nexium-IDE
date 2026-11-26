import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";

export { invoke };

/** True only inside the Tauri shell, where local filesystem access exists. */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Tauri rejects a command with the value of its `Err`, which is a plain
 * string, so `instanceof Error` checks hid every real failure behind a
 * generic "Request failed" message.
 */
export function toError(cause: unknown, fallback: string): Error {
  if (cause instanceof Error) {
    return cause;
  }

  if (typeof cause === "string" && cause.trim().length > 0) {
    return new Error(cause.trim());
  }

  return new Error(fallback);
}

export async function pickFolder(): Promise<string | null> {
  if (!isTauri()) {
    return null;
  }

  const selection = await open({
    directory: true,
    multiple: false,
    title: "Open a folder",
  });

  return typeof selection === "string" ? selection : null;
}

/**
 * A save dialog is the only native picker that asks for a folder name and a
 * parent in one step, which is exactly what a new project needs. Nothing is
 * written: the chosen path becomes the project folder.
 */
export async function pickNewProjectPath(): Promise<string | null> {
  if (!isTauri()) {
    return null;
  }

  const selection = await save({ title: "New project" });

  return typeof selection === "string" ? selection : null;
}
