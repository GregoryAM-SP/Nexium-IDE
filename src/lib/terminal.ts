import { invoke, isTauri, toError } from "./tauriBridge";

/** True only in the desktop shell, where a real pseudo-terminal exists. */
export function terminalAvailable(): boolean {
  return isTauri();
}

/**
 * Starts a shell, or with `run`, that one command line in `dir` (a folder
 * inside the project), whose exit ends the session.
 */
export async function startTerminal(
  id: string,
  rows: number,
  cols: number,
  run: string | null = null,
  dir: string | null = null,
): Promise<string> {
  try {
    return await invoke<string>("terminal_start", { id, rows, cols, run, dir });
  } catch (cause) {
    throw toError(cause, "The terminal could not start.");
  }
}

export async function writeTerminal(id: string, data: string): Promise<void> {
  try {
    await invoke("terminal_write", { id, data });
  } catch (cause) {
    throw toError(cause, "The terminal could not be written to.");
  }
}

export async function resizeTerminal(
  id: string,
  rows: number,
  cols: number,
): Promise<void> {
  try {
    await invoke("terminal_resize", { id, rows, cols });
  } catch (cause) {
    throw toError(cause, "The terminal could not be resized.");
  }
}

export async function killTerminal(id: string): Promise<void> {
  try {
    await invoke("terminal_kill", { id });
  } catch {
    // Closing a terminal that already exited needs no second error.
  }
}
