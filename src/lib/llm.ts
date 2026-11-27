// Inside the desktop app every request goes through Rust (`ai_*` commands),
// which works with any provider and keeps keys out of the webview's network
// log. The browser-only dev build calls providers directly with fetch; NVIDIA
// sends no CORS headers, so it goes through the Vite proxy (vite.config.ts).
import type { ModelTarget } from "./assistantSettings";
import { invoke, isTauri, toError } from "./tauriBridge";

export type ChatRole = "system" | "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

/** Where a request goes: display name, base URL and key (may be empty). */
export type Endpoint = {
  name: string;
  baseUrl: string;
  apiKey: string;
};

export const endpointOf = (target: ModelTarget): Endpoint => ({
  name: target.name,
  baseUrl: target.baseUrl,
  apiKey: target.apiKey,
});

export type ProbeResult = {
  working: string[];
  latency: Record<string, number>;
  failed: Record<string, string>;
  total: number;
};

export type AgentStep = {
  id: number;
  kind: string;
  title: string;
  detail?: string | null;
  /** running | awaiting (a change waiting on Accept/Reject) | done | error */
  status: string;
  /** The tool behind the step: list_files, read_file, edit_file, … */
  tool?: string;
  /** The workspace file the step is about. */
  path?: string;
  /** The checklist, on a step of kind "objectives" (one per run, kept current). */
  objectives?: Objective[];
};

/** One goal on the checklist the agent keeps for a multi-step task. */
export type Objective = {
  title: string;
  status: "pending" | "in_progress" | "done";
};

/**
 * A file change (shown as a diff) or a command the agent proposes; nothing is
 * written or run until it is accepted.
 */
export type ApprovalRequest = {
  kind?: "change" | "command";
  stepId: number;
  path: string;
  before: string;
  after: string;
  created: boolean;
  /** The command line, for kind "command". */
  command?: string;
  /** The session whose run asked. */
  session?: string;
};

export type AgentDelta = {
  kind: string;
  text: string;
};

export type AgentReply = {
  text: string;
  reasoning: string | null;
  steps: AgentStep[];
  tools_enabled: boolean;
  /** Every tool step was spent; the conversation can be continued. */
  out_of_steps?: boolean;
};

// ── Browser-only fallback ───────────────────────────────────────────────────

function browserUrl(endpoint: Endpoint, path: string): string {
  const base = endpoint.baseUrl
    .trim()
    .replace(/\/+$/, "")
    .replace(/^https:\/\/integrate\.api\.nvidia\.com/, "/nim");

  return `${base}/${path}`;
}

function browserHeaders(endpoint: Endpoint): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (endpoint.apiKey.trim()) {
    headers.Authorization = `Bearer ${endpoint.apiKey.trim()}`;
  }

  return headers;
}

async function readDetail(res: Response): Promise<string | undefined> {
  try {
    const parsed = (await res.json()) as {
      detail?: unknown;
      message?: unknown;
      error?: unknown;
    };
    const error = parsed.error as { message?: unknown } | string | undefined;
    const detail =
      parsed.detail ??
      (typeof error === "object" ? error?.message : error) ??
      parsed.message;

    return typeof detail === "string" ? detail.slice(0, 300) : undefined;
  } catch {
    return undefined;
  }
}

function describeError(name: string, status: number, detail?: string): string {
  if (status === 401 || status === 403) {
    return detail
      ? `${name} rejected the request: ${detail}`
      : `${name} rejected this API key. Check it in Settings.`;
  }

  if (status === 429) {
    return `${name} rate limit reached. Wait a moment and try again, or switch provider.`;
  }

  if (status >= 500) {
    return `${name} returned a server error. Try again shortly.`;
  }

  return detail ?? `${name} request failed (${status}).`;
}

async function browserFetch(
  endpoint: Endpoint,
  path: string,
  body?: unknown,
): Promise<unknown> {
  let res: Response;

  try {
    res = await fetch(browserUrl(endpoint, path), {
      method: body === undefined ? "GET" : "POST",
      headers: browserHeaders(endpoint),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error(
      `Could not reach ${endpoint.name} from the browser build (it may not allow cross-origin requests). Use the desktop app.`,
    );
  }

  if (!res.ok) {
    throw new Error(describeError(endpoint.name, res.status, await readDetail(res)));
  }

  return res.json();
}

function replyText(body: unknown): string {
  const message = (
    body as {
      choices?: {
        message?: {
          content?: string | null;
          reasoning_content?: string | null;
          reasoning?: string | null;
        };
      }[];
    }
  ).choices?.[0]?.message;

  // Reasoning models sometimes spend a small budget entirely on thinking.
  return (
    message?.content ||
    message?.reasoning_content ||
    message?.reasoning ||
    ""
  ).trim();
}

/** The answer alone, never the reasoning channel. */
function answerText(body: unknown): string {
  return (
    (
      body as { choices?: { message?: { content?: string | null } }[] }
    ).choices?.[0]?.message?.content ?? ""
  ).trim();
}

// ── Public API ──────────────────────────────────────────────────────────────

/** A model in a provider's catalogue, with its context window if reported. */
export type ModelInfo = {
  id: string;
  contextWindow?: number;
};

const CONTEXT_KEYS = [
  "context_length",
  "context_window",
  "max_model_len",
  "max_context_length",
  "input_token_limit",
  "inputTokenLimit",
];

/** The provider's model catalogue. */
export async function listModels(endpoint: Endpoint): Promise<ModelInfo[]> {
  if (isTauri()) {
    try {
      return await invoke<ModelInfo[]>("ai_models", { endpoint });
    } catch (cause) {
      throw toError(cause, `Could not load ${endpoint.name}'s models.`);
    }
  }

  const body = (await browserFetch(endpoint, "models")) as {
    data?: Record<string, unknown>[];
  };

  return (body.data ?? [])
    .flatMap((item): ModelInfo[] => {
      if (typeof item.id !== "string") {
        return [];
      }

      const top = item.top_provider as Record<string, unknown> | undefined;
      const raw =
        CONTEXT_KEYS.map((key) => item[key]).find((value) => value != null) ??
        top?.context_length;
      const tokens = Number(raw);

      return [
        {
          id: item.id,
          contextWindow:
            Number.isFinite(tokens) && tokens >= 512 ? tokens : undefined,
        },
      ];
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Sends each model a one-token request; only the ones that answer work. */
export async function probeModels(
  endpoint: Endpoint,
  models: string[],
): Promise<ProbeResult> {
  if (isTauri()) {
    try {
      return await invoke<ProbeResult>("ai_probe", { endpoint, models });
    } catch (cause) {
      throw toError(cause, "The models could not be tested.");
    }
  }

  const result: ProbeResult = {
    working: [],
    latency: {},
    failed: {},
    total: models.length,
  };

  for (const model of models.slice(0, 40)) {
    const started = performance.now();

    try {
      await browserFetch(endpoint, "chat/completions", {
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
      });
      result.working.push(model);
      result.latency[model] = Math.round(performance.now() - started);
    } catch (cause) {
      result.failed[model] = toError(cause, "No answer.").message;
    }
  }

  result.working.sort(
    (a, b) => (result.latency[a] ?? 0) - (result.latency[b] ?? 0),
  );

  return result;
}

export async function pingModel(
  target: ModelTarget,
): Promise<{ reply: string; ms: number }> {
  const endpoint = endpointOf(target);

  if (isTauri()) {
    try {
      return await invoke<{ reply: string; ms: number }>("ai_ping", {
        endpoint,
        model: target.model,
      });
    } catch (cause) {
      throw toError(cause, "The connection test failed.");
    }
  }

  const started = performance.now();
  const body = await browserFetch(endpoint, "chat/completions", {
    model: target.model,
    messages: [{ role: "user", content: "Reply with the single word: ok" }],
    max_tokens: 16,
  });

  return {
    reply: replyText(body) || "(empty reply)",
    ms: Math.round(performance.now() - started),
  };
}

/**
 * A plain completion. `fast` is for inline suggestions: the model is asked not
 * to reason first (a thinking model otherwise spends 20+ seconds and its whole
 * token budget on a five-character completion), and only the answer counts.
 */
export async function chat(
  target: ModelTarget,
  messages: ChatMessage[],
  maxTokens = 1024,
  fast = false,
): Promise<string> {
  const endpoint = endpointOf(target);

  if (isTauri()) {
    try {
      return await invoke<string>("ai_chat", {
        endpoint,
        model: target.model,
        messages,
        maxTokens,
        fast,
      });
    } catch (cause) {
      throw toError(cause, "The assistant request failed.");
    }
  }

  const request = {
    model: target.model,
    messages,
    max_tokens: maxTokens,
  };
  let body: unknown;

  try {
    body = await browserFetch(
      endpoint,
      "chat/completions",
      fast ? { ...request, reasoning_effort: "none" } : request,
    );
  } catch (cause) {
    // Some providers reject the option; ask again without it.
    if (!fast) {
      throw cause;
    }

    body = await browserFetch(endpoint, "chat/completions", request);
  }

  const content = fast ? answerText(body) : replyText(body);

  if (!content) {
    throw new Error("The model returned an empty reply.");
  }

  return content;
}

/**
 * Runs the tool-calling loop in Rust (files are read and written there) and
 * forwards each step as it happens. The browser build has no filesystem, so it
 * falls back to a plain completion. Note: browser mode does not support
 * streaming deltas or tool calls - it returns the full response at once.
 */
export async function runAgent(
  target: ModelTarget,
  messages: ChatMessage[],
  autoApprove = false,
  /** The model's context window in tokens; old tool output is trimmed to fit. */
  contextWindow?: number,
  /** The session the run belongs to; its events carry this id. */
  sessionId?: string,
): Promise<AgentReply> {
  if (isTauri()) {
    try {
      return await invoke<AgentReply>("ai_agent", {
        endpoint: endpointOf(target),
        model: target.model,
        messages,
        autoApprove,
        contextWindow: contextWindow ?? null,
        sessionId: sessionId ?? null,
      });
    } catch (cause) {
      throw toError(cause, "The assistant request failed.");
    }
  }

  // Browser fallback: single completion without tools or streaming.
  // The caller should treat this as a complete response with no intermediate steps.
  const text = await chat(target, messages);

  return { text, reasoning: null, steps: [], tools_enabled: false };
}

/** Accepts or rejects a change the running agent proposed. */
export async function decideChange(
  sessionId: string,
  stepId: number,
  accept: boolean,
): Promise<void> {
  if (!isTauri()) {
    return;
  }

  try {
    await invoke<void>("agent_decide", { sessionId, stepId, accept });
  } catch (cause) {
    throw toError(cause, "The decision could not be sent.");
  }
}

/** Asks the running agent loop to stop; it returns "Stopped.". */
/** Stops one session's run (or every run, without an id). */
export async function cancelAgent(sessionId?: string): Promise<void> {
  if (!isTauri()) {
    return;
  }

  try {
    await invoke<void>("ai_cancel", { sessionId: sessionId ?? null });
  } catch {
    // Nothing to report: the run is already finishing or finished.
  }
}
