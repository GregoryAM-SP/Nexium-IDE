import * as monaco from "monaco-editor";

import type { ModelTarget } from "./assistantSettings";
import { chat } from "./llm";

/**
 * AI inline completions: after a pause in typing, the editor asks the selected
 * model for the next few tokens and shows them as ghost text at the cursor. Tab
 * accepts, Escape dismisses, and nothing is inserted until one of those.
 */

/** Long enough that a burst of typing never sends a request of its own. */
const DEBOUNCE_MS = 700;
/** The model only needs the neighbourhood of the cursor, not the whole file. */
const MAX_PREFIX_CHARS = 2600;
const MAX_SUFFIX_CHARS = 600;
const MAX_SUGGESTION_LINES = 4;
const MAX_SUGGESTION_CHARS = 320;
const CACHE_ENTRIES = 60;

const SYSTEM_PROMPT = [
  "You are the inline completion engine of a code editor. The user is typing and needs the next few tokens.",
  "Reply with the exact code to insert at the cursor and nothing else.",
  "Never repeat code that appears before or after the cursor.",
  "No markdown fences, no prose, no comments explaining the suggestion.",
  `At most ${MAX_SUGGESTION_LINES} lines; prefer finishing the current statement to starting a new one.`,
  "If nothing sensible can follow, reply with an empty string.",
].join(" ");

/** The model suggestions come from; null turns suggestions off. */
let target: ModelTarget | null = null;

/** Only the newest request may answer; every keystroke supersedes the last. */
let generation = 0;

/** Suggestions are deterministic for the same spot, so repeats are free. */
const cache = new Map<string, string>();

function remember(key: string, value: string): void {
  if (cache.size >= CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;

    if (oldest !== undefined) {
      cache.delete(oldest);
    }
  }

  cache.set(key, value);
}

const targetKey = (value: ModelTarget | null) =>
  value
    ? `${value.provider}|${value.baseUrl}|${value.model}|${value.apiKey.length}`
    : "";

/** The provider and model to ask; null (no model set up) sends nothing. */
export function setInlineCompletionModel(next: ModelTarget | null): void {
  if (targetKey(next) !== targetKey(target)) {
    cache.clear();
  }

  target = next;
}

type PromptInput = {
  path: string;
  language: string;
  prefix: string;
  suffix: string;
};

/** The question sent with every completion request. */
export function completionPrompt({
  path,
  language,
  prefix,
  suffix,
}: PromptInput): string {
  return [
    `File: ${path || "(untitled)"}`,
    `Language: ${language}`,
    "",
    "Code before the cursor:",
    prefix || "(start of file)",
    "",
    "Code after the cursor:",
    suffix || "(end of file)",
    "",
    "Complete only what belongs at the cursor.",
  ].join("\n");
}

/**
 * Models often answer with a fence, a prose line or a copy of what is already
 * after the cursor; all of that is stripped so only insertable code is left.
 */
export function cleanCompletion(reply: string, suffix: string): string {
  let text = reply.replace(/\r\n/g, "\n");

  const fenced = /^\s*```[^\n]*\n([\s\S]*?)\n```\s*$/.exec(text);

  if (fenced) {
    text = fenced[1];
  }

  text = text.replace(/^<\|?cursor\|?>\s*/i, "");
  text = text.replace(/^[\s\S]*?<\|cursor\|>/i, "");
  text = text.trimEnd();

  if (!text.trim()) {
    return "";
  }

  const lines = text.split("\n");

  if (lines.length > MAX_SUGGESTION_LINES) {
    text = lines.slice(0, MAX_SUGGESTION_LINES).join("\n");
  }

  if (text.length > MAX_SUGGESTION_CHARS) {
    text = text.slice(0, MAX_SUGGESTION_CHARS);
  }

  // A suggestion that is already sitting in the file adds nothing.
  if (suffix.startsWith(text)) {
    return "";
  }

  return text;
}

async function completeInline(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
  token: monaco.CancellationToken,
): Promise<string> {
  const using = target;

  if (!using) {
    return "";
  }

  // Diff models are app-owned mirrors of a file, not something to complete.
  if (model.uri.scheme === "inmemory" || model.isDisposed()) {
    return "";
  }

  const offset = model.getOffsetAt(position);
  const full = model.getValue();
  const prefix = full.slice(Math.max(0, offset - MAX_PREFIX_CHARS), offset);
  const suffix = full.slice(offset, offset + MAX_SUFFIX_CHARS);

  if (!prefix.trim()) {
    return "";
  }

  // Monaco debounces the request itself (see `debounceDelayMs` below); anything
  // older than the newest request is dropped when it comes back.
  const current = generation + 1;
  generation = current;

  const key = `${model.uri.toString()}|${offset}|${prefix.slice(-160)}`;
  const cached = cache.get(key);

  if (cached !== undefined) {
    return cached;
  }

  let reply: string;

  try {
    reply = await chat(using, [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: completionPrompt({
          path: model.uri.path.replace(/^\/+/, ""),
          language: model.getLanguageId(),
          prefix,
          suffix,
        }),
      },
    ], 160);
  } catch {
    // A suggestion that never arrives must not interrupt typing.
    return "";
  }

  if (token.isCancellationRequested || current !== generation) {
    return "";
  }

  const suggestion = cleanCompletion(reply, suffix);

  remember(key, suggestion);

  return suggestion;
}

/** Registered once, for every language and every editor. */
export function registerInlineCompletions(): void {
  const provider: monaco.languages.InlineCompletionsProvider = {
    // A pause, not every keystroke: bursts of typing never reach the network.
    debounceDelayMs: DEBOUNCE_MS,
    async provideInlineCompletions(model, position, _context, token) {
      const text = await completeInline(model, position, token);

      if (!text) {
        return { items: [] };
      }

      return {
        items: [
          {
            insertText: text,
            range: new monaco.Range(
              position.lineNumber,
              position.column,
              position.lineNumber,
              position.column,
            ),
          },
        ],
      };
    },
    disposeInlineCompletions() {
      // Suggestions are plain strings, so there is nothing to release.
    },
  };

  monaco.languages.registerInlineCompletionsProvider({ pattern: "**" }, provider);
}
