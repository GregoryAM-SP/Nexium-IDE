// Requests go through the Vite proxy (see vite.config.ts) in the browser build,
// and through Rust (`nim_verify` / `nim_chat`) inside the desktop app.
import { invoke, isTauri, toError } from "./tauriBridge";

const NIM_BASE = "/nim/v1";

export type NimModelInfo = {
  id: string;
  ownedBy: string;
};

export type ChatRole = "system" | "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

export type ProbeOutcome =
  | "working"
  | "unavailable"
  | "unauthorized"
  | "rate-limited";

export type VerificationProgress = {
  done: number;
  total: number;
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function readDetail(res: Response): Promise<string | undefined> {
  try {
    const text = await res.text();

    if (!text) {
      return undefined;
    }

    const parsed = JSON.parse(text) as { detail?: unknown; message?: unknown };
    const detail = parsed.detail ?? parsed.message;

    return typeof detail === "string" ? detail : undefined;
  } catch {
    return undefined;
  }
}

function describeError(status: number, detail?: string): string {
  if (status === 401 || status === 403) {
    return "NVIDIA rejected this API key. Check it at build.nvidia.com/settings/api-keys.";
  }

  if (status === 410 || status === 404) {
    return detail ?? "That model is no longer available.";
  }

  if (status === 429) {
    return "NVIDIA rate limit reached (40 requests per minute on the free tier). Wait a moment and try again.";
  }

  if (status === 400 || status === 422) {
    return detail ?? "NVIDIA rejected the request for that model.";
  }

  if (status >= 500) {
    return "NVIDIA NIM returned a server error. Try again shortly.";
  }

  return detail ?? `NVIDIA NIM request failed (${status}).`;
}

/** The catalogue is public: it lists models whether or not they are callable. */
export async function listModels(): Promise<NimModelInfo[]> {
  const res = await fetch(`${NIM_BASE}/models`, {
    headers: { Accept: "application/json" },
  });

  if (!res.ok) {
    throw new Error(describeError(res.status, await readDetail(res)));
  }

  const body = (await res.json()) as {
    data?: { id?: unknown; owned_by?: unknown }[];
  };

  const models: NimModelInfo[] = [];

  for (const entry of body.data ?? []) {
    if (typeof entry.id === "string") {
      models.push({
        id: entry.id,
        ownedBy:
          typeof entry.owned_by === "string" ? entry.owned_by : "unknown",
      });
    }
  }

  return models.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * The catalogue is not a capability list, so the only reliable way to know a
 * model answers chat completions with this key is to send one.
 */
export async function probeModel(
  apiKey: string,
  model: string,
): Promise<ProbeOutcome> {
  const res = await fetch(`${NIM_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
    }),
  });

  // Drain the body so the connection is released either way.
  await res.text().catch(() => "");

  if (res.ok) {
    return "working";
  }

  if (res.status === 401 || res.status === 403) {
    return "unauthorized";
  }

  if (res.status === 429) {
    return "rate-limited";
  }

  return "unavailable";
}

async function probeWithRetry(
  apiKey: string,
  model: string,
): Promise<ProbeOutcome> {
  const first = await probeModel(apiKey, model);

  if (first !== "rate-limited") {
    return first;
  }

  await delay(2500);

  return probeModel(apiKey, model);
}

/** Probes every id and returns only the models that answered a real request. */
export async function verifyModels(
  apiKey: string,
  ids: string[],
  onProgress?: (progress: VerificationProgress) => void,
): Promise<string[]> {
  const queue = [...ids];
  const working: string[] = [];
  const total = ids.length;
  let done = 0;
  let unauthorized = false;

  const worker = async () => {
    for (;;) {
      const model = queue.shift();

      if (!model || unauthorized) {
        return;
      }

      const outcome = await probeWithRetry(apiKey, model);

      if (outcome === "unauthorized") {
        unauthorized = true;
        queue.length = 0;
        return;
      }

      if (outcome === "working") {
        working.push(model);
      }

      done += 1;
      onProgress?.({ done, total });
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(3, queue.length) }, () => worker()),
  );

  if (unauthorized) {
    throw new Error(
      "NVIDIA rejected this API key. Check it at build.nvidia.com/settings/api-keys.",
    );
  }

  return working.sort((a, b) => a.localeCompare(b));
}

export type VerificationResult = {
  working: string[];
  /** Probe round-trip in milliseconds, keyed by model id. */
  latency?: Record<string, number>;
  total: number;
};

export type AgentStep = {
  id: number;
  kind: string;
  title: string;
  detail?: string | null;
  status: string;
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
};

/**
 * Runs the tool-calling loop in Rust (files are read and written there) and
 * forwards each step as it happens. The browser build has no filesystem, so it
 * falls back to a plain completion.
 */
export async function runAgent(
  apiKey: string,
  model: string,
  messages: ChatMessage[],
): Promise<AgentReply> {
  if (isTauri()) {
    try {
      return await invoke<AgentReply>("nim_agent", { apiKey, model, messages });
    } catch (cause) {
      throw toError(cause, "The assistant request failed.");
    }
  }

  const text = await chat(apiKey, model, messages);

  return { text, reasoning: null, steps: [], tools_enabled: false };
}

/** Asks the running agent loop to stop; it returns "Stopped.". */
export async function cancelAgent(): Promise<void> {
  if (!isTauri()) {
    return;
  }

  try {
    await invoke<void>("nim_cancel");
  } catch {
    // Nothing to report: the run is already finishing or finished.
  }
}

/**
 * Verifies the key and returns only models that answered a real request. Rust
 * does the probing in the desktop app; the browser build needs the proxy.
 */
export async function verifyModelsForKey(
  apiKey: string,
  onProgress?: (progress: VerificationProgress) => void,
): Promise<VerificationResult> {
  if (isTauri()) {
    try {
      return await invoke<VerificationResult>("nim_verify", { apiKey });
    } catch (cause) {
      throw toError(cause, "Model verification failed.");
    }
  }

  const listed = await listModels();
  const working = await verifyModels(
    apiKey,
    listed.map((entry) => entry.id),
    onProgress,
  );

  return { working, total: listed.length };
}

export async function pingModel(
  apiKey: string,
  model: string,
): Promise<string> {
  if (isTauri()) {
    try {
      return await invoke<string>("nim_ping", { apiKey, model });
    } catch (cause) {
      throw toError(cause, "The connection test failed.");
    }
  }

  return chat(apiKey, model, [{ role: "user", content: "ping" }]);
}

export async function chat(
  apiKey: string,
  model: string,
  messages: ChatMessage[],
): Promise<string> {
  if (isTauri()) {
    try {
      return await invoke<string>("nim_chat", { apiKey, model, messages });
    } catch (cause) {
      throw toError(cause, "The assistant request failed.");
    }
  }

  const res = await fetch(`${NIM_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, messages, max_tokens: 1024 }),
  });

  if (!res.ok) {
    throw new Error(describeError(res.status, await readDetail(res)));
  }

  const body = (await res.json()) as {
    choices?: { message?: { content?: string | null } }[];
  };

  const content = body.choices?.[0]?.message?.content?.trim();

  if (!content) {
    throw new Error("The model returned an empty reply.");
  }

  return content;
}
