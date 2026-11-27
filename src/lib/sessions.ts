/**
 * Assistant sessions: separate conversations kept in the app's SQLite
 * database, per project folder. Several can run at once; the agent
 * coordinates them (file locks, a shared activity log) on the Rust side.
 *
 * The browser build has no database, so it keeps sessions in localStorage.
 */
import type { AssistantMessage } from "./assistantMessages";
import type { CondensedHistory } from "./contextBudget";
import { invoke, isTauri } from "./tauriBridge";

export type SessionSummary = {
  id: string;
  project: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  messageCount: number;
  /** An agent run is working in this session now. */
  running?: boolean;
};

export type SessionData = {
  session: SessionSummary;
  messages: AssistantMessage[];
  condensed: CondensedHistory | null;
};

export const UNTITLED = "New session";

/** A session's name from its first request: the first line, shortened. */
export function titleFrom(text: string): string {
  const line = text.trim().split("\n")[0].replace(/\s+/g, " ");
  return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line || UNTITLED;
}

// ── browser fallback ────────────────────────────────────────────────────────

const BROWSER_KEY = "nexium.sessions";

type BrowserStore = Record<string, SessionData>;

function browserStore(): BrowserStore {
  try {
    return JSON.parse(localStorage.getItem(BROWSER_KEY) ?? "{}") as BrowserStore;
  } catch {
    return {};
  }
}

function saveBrowserStore(store: BrowserStore) {
  try {
    localStorage.setItem(BROWSER_KEY, JSON.stringify(store));
  } catch {
    // Full or unavailable storage: the session lasts until reload.
  }
}

function browserId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

// ── API ─────────────────────────────────────────────────────────────────────

export async function listSessions(includeArchived: boolean): Promise<SessionSummary[]> {
  if (isTauri()) {
    return invoke<SessionSummary[]>("sessions_list", { includeArchived });
  }

  return Object.values(browserStore())
    .map((data) => ({ ...data.session, messageCount: data.messages.length }))
    .filter((session) => includeArchived || !session.archived)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function createSession(title: string = UNTITLED): Promise<SessionSummary> {
  if (isTauri()) {
    return invoke<SessionSummary>("session_create", { title });
  }

  const now = Date.now();
  const session: SessionSummary = {
    id: browserId(),
    project: "",
    title,
    createdAt: now,
    updatedAt: now,
    archived: false,
    messageCount: 0,
  };
  const store = browserStore();
  store[session.id] = { session, messages: [], condensed: null };
  saveBrowserStore(store);
  return session;
}

export async function loadSession(id: string): Promise<SessionData> {
  if (isTauri()) {
    return invoke<SessionData>("session_load", { id });
  }

  const data = browserStore()[id];
  if (!data) {
    throw new Error("That session no longer exists.");
  }
  return data;
}

export async function saveSession(
  id: string,
  messages: AssistantMessage[],
  condensed: CondensedHistory | null,
): Promise<void> {
  if (isTauri()) {
    return invoke<void>("session_save", { id, messages, condensed });
  }

  const store = browserStore();
  const data = store[id];
  if (data) {
    store[id] = {
      session: { ...data.session, updatedAt: Date.now(), messageCount: messages.length },
      messages,
      condensed,
    };
    saveBrowserStore(store);
  }
}

export async function renameSession(id: string, title: string): Promise<void> {
  if (isTauri()) {
    return invoke<void>("session_rename", { id, title });
  }

  const store = browserStore();
  if (store[id]) {
    store[id].session.title = title;
    saveBrowserStore(store);
  }
}

export async function archiveSession(id: string, archived: boolean): Promise<void> {
  if (isTauri()) {
    return invoke<void>("session_archive", { id, archived });
  }

  const store = browserStore();
  if (store[id]) {
    store[id].session.archived = archived;
    saveBrowserStore(store);
  }
}

export async function deleteSession(id: string): Promise<void> {
  if (isTauri()) {
    return invoke<void>("session_delete", { id });
  }

  const store = browserStore();
  delete store[id];
  saveBrowserStore(store);
}
