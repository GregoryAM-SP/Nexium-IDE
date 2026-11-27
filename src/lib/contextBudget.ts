/**
 * How much of a model's context window the next assistant request uses, and
 * when to condense older turns so a conversation never reaches 100%.
 *
 * Token counts are estimates (about 3.5 characters per token for English and
 * code). Every request also carries the assistant's policy, the tool schema
 * and a workspace listing, and needs room for the reply, so those are counted
 * up front rather than discovered when the provider rejects the request.
 */
import type { AssistantMessage } from "./assistantMessages";
import { historyContent } from "./assistantMessages";

/** Older turns are summarised once the next request would pass this share. */
export const CONDENSE_AT = 0.8;
/** The most recent messages (two exchanges) stay word for word when they fit. */
export const KEEP_RECENT = 4;
/** When two exchanges alone are too big, only the last one is kept. */
export const KEEP_MINIMUM = 2;
/** Used when a provider does not report a model's context window. */
export const DEFAULT_CONTEXT = 32_768;
/** Local servers usually run models with a small context unless told otherwise. */
export const DEFAULT_LOCAL_CONTEXT = 8_192;

const CHARS_PER_TOKEN = 3.5;
/** Policy, tool schema and workspace listing sent with every request. */
const SYSTEM_OVERHEAD = 2_500;
/** The agent asks for up to 4 096 reply tokens; small windows reserve a quarter. */
const REPLY_RESERVE = 4_096;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function replyReserve(window: number): number {
  return Math.min(REPLY_RESERVE, Math.floor(window / 4));
}

/** The earlier conversation, summarised, standing in for the messages it covers. */
export type CondensedHistory = {
  summary: string;
  /** Messages with an id up to and including this one are covered by the summary. */
  throughId: number;
  /** Roughly how many tokens the summary saved. */
  saved: number;
};

/** The messages the model still sees verbatim. */
export function liveMessages(
  messages: AssistantMessage[],
  condensed: CondensedHistory | null,
): AssistantMessage[] {
  return messages.filter(
    (message) =>
      !message.error && (!condensed || message.id > condensed.throughId),
  );
}

export function summaryMessage(condensed: CondensedHistory): string {
  return `Summary of the earlier part of this conversation (older messages were condensed to save context):\n\n${condensed.summary}`;
}

export type ContextUsage = {
  used: number;
  window: number;
  /** used / window, 0–1+. */
  ratio: number;
};

export function contextUsage({
  window,
  messages,
  condensed,
  openFileChars,
  draft = "",
}: {
  window: number;
  messages: AssistantMessage[];
  condensed: CondensedHistory | null;
  openFileChars: number;
  draft?: string;
}): ContextUsage {
  const history = liveMessages(messages, condensed).reduce(
    (total, message) =>
      total +
      estimateTokens(
        message.role === "assistant" ? historyContent(message) : message.text,
      ) +
      4,
    0,
  );

  const used =
    SYSTEM_OVERHEAD +
    replyReserve(window) +
    estimateTokens(" ".repeat(openFileChars)) +
    (condensed ? estimateTokens(summaryMessage(condensed)) : 0) +
    history +
    estimateTokens(draft);

  return { used, window, ratio: used / Math.max(1, window) };
}

/**
 * The messages to fold into a new summary: everything the model still sees
 * except the most recent exchanges. Empty when there is nothing old enough.
 */
export function messagesToCondense(
  messages: AssistantMessage[],
  condensed: CondensedHistory | null,
  keep = KEEP_RECENT,
): AssistantMessage[] {
  const live = liveMessages(messages, condensed);
  return live.length > keep ? live.slice(0, live.length - keep) : [];
}

/** Rough size of a summary of `tokens` worth of conversation. */
export function expectedSummaryTokens(tokens: number): number {
  return Math.min(tokens, Math.max(150, Math.round(tokens * 0.2)), 1_500);
}

/**
 * How many recent messages to keep verbatim: two exchanges, unless even after
 * summarising the rest the next request would still be over the threshold.
 */
export function messagesToKeep(
  usage: (condensed: CondensedHistory | null) => ContextUsage,
  messages: AssistantMessage[],
  condensed: CondensedHistory | null,
): number {
  const older = messagesToCondense(messages, condensed, KEEP_RECENT);

  if (older.length === 0) {
    return messagesToCondense(messages, condensed, KEEP_MINIMUM).length > 0
      ? KEEP_MINIMUM
      : KEEP_RECENT;
  }

  const olderTokens = older.reduce(
    (total, message) =>
      total +
      estimateTokens(
        message.role === "assistant" ? historyContent(message) : message.text,
      ),
    0,
  );
  const after = usage({
    summary: "x".repeat(
      Math.ceil(
        expectedSummaryTokens(olderTokens + (condensed ? estimateTokens(condensed.summary) : 0)) *
          CHARS_PER_TOKEN,
      ),
    ),
    throughId: older[older.length - 1].id,
    saved: 0,
  });

  return after.ratio >= CONDENSE_AT &&
    messagesToCondense(messages, condensed, KEEP_MINIMUM).length > older.length
    ? KEEP_MINIMUM
    : KEEP_RECENT;
}

/** Longest transcript sent to the summariser, so the summary call itself fits. */
function transcriptBudget(window: number): number {
  return Math.max(2_000, Math.floor((window * 0.6 - replyReserve(window)) * CHARS_PER_TOKEN));
}

/** The request that asks the model to summarise older turns. */
export function condenseRequest(
  older: AssistantMessage[],
  previous: CondensedHistory | null,
  window: number,
): { role: "system" | "user"; content: string }[] {
  let transcript = older
    .map(
      (message) =>
        `${message.role === "user" ? "User" : "Assistant"}: ${
          message.role === "assistant" ? historyContent(message) : message.text
        }`,
    )
    .join("\n\n");

  const budget = transcriptBudget(window);

  if (transcript.length > budget) {
    // Keep the end of the transcript: it is closest to what happens next.
    transcript = `…\n${transcript.slice(transcript.length - budget)}`;
  }

  return [
    {
      role: "system",
      content: [
        "You condense a coding assistant's conversation so it can continue with less context.",
        "Write a compact summary that keeps everything needed to carry on: the user's goals and preferences, decisions made, files read or changed (with paths), code facts discovered, errors hit and how they were resolved, and anything still open or promised.",
        "Use short bullet points grouped under brief headings. Keep exact file paths, names, commands and numbers. Leave out pleasantries and anything already superseded.",
        "Reply with the summary only.",
      ].join(" "),
    },
    {
      role: "user",
      content: `${
        previous
          ? `Summary so far:\n${previous.summary}\n\nConversation since then:\n`
          : "Conversation:\n"
      }${transcript}`,
    },
  ];
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1)}M`;
  }

  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(tokens >= 10_000 ? 0 : 1)}k`;
  }

  return String(tokens);
}
