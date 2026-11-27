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
};

/** A file change the agent proposes; nothing is written until it is accepted. */
export type ApprovalRequest = {
  stepId: number;
  path: string;
  before: string;
  after: string;
  created: boolean;
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

// ── Public API ──────────────────────────────────────────────────────────────

/** The provider's model catalogue. */
export async function listModels(endpoint: Endpoint): Promise<string[]> {
  if (isTauri()) {
    try {
      return await invoke<string[]>("ai_models", { endpoint });
    } catch (cause) {
      throw toError(cause, `Could not load ${endpoint.name}'s models.`);
    }
  }

  const body = (await browserFetch(endpoint, "models")) as {
    data?: { id?: string }[];
  };

  return (body.data ?? [])
    .flatMap((item) => (typeof item.id === "string" ? [item.id] : []))
    .sort((a, b) => a.localeCompare(b));
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

export async function chat(
  target: ModelTarget,
  messages: ChatMessage[],
  maxTokens = 1024,
): Promise<string> {
  const endpoint = endpointOf(target);

  if (isTauri()) {
    try {
      return await invoke<string>("ai_chat", {
        endpoint,
        model: target.model,
        messages,
        maxTokens,
      });
    } catch (cause) {
      throw toError(cause, "The assistant request failed.");
    }
  }

  const content = replyText(
    await browserFetch(endpoint, "chat/completions", {
      model: target.model,
      messages,
      max_tokens: maxTokens,
    }),
  );

  if (!content) {
    throw new Error("The model returned an empty reply.");
  }

  return content;
}

/**
 * Runs the tool-calling loop in Rust (files are read and written there) and
 * forwards each step as it happens. The browser build has no filesystem, so it
 * falls back to a plain completion.
 */
export async function runAgent(
  target: ModelTarget,
  messages: ChatMessage[],
  autoApprove = false,
): Promise<AgentReply> {
  if (isTauri()) {
    try {
      return await invoke<AgentReply>("ai_agent", {
        endpoint: endpointOf(target),
        model: target.model,
        messages,
        autoApprove,
      });
    } catch (cause) {
      throw toError(cause, "The assistant request failed.");
    }
  }

  const text = await chat(target, messages);

  return { text, reasoning: null, steps: [], tools_enabled: false };
}

/** Accepts or rejects a change the running agent proposed. */
export async function decideChange(
  stepId: number,
  accept: boolean,
): Promise<void> {
  if (!isTauri()) {
    return;
  }

  try {
    await invoke<void>("agent_decide", { stepId, accept });
  } catch (cause) {
    throw toError(cause, "The decision could not be sent.");
  }
}

/** Asks the running agent loop to stop; it returns "Stopped.". */
export async function cancelAgent(): Promise<void> {
  if (!isTauri()) {
    return;
  }

  try {
    await invoke<void>("ai_cancel");
  } catch {
    // Nothing to report: the run is already finishing or finished.
  }
}
