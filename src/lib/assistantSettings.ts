export type AssistantSettings = {
  apiKey: string;
  model: string;
  workingModels: string[];
  /** Probe round-trip per model, so a stalled model can fall back to a fast one. */
  latency: Record<string, number>;
  verifiedAt: number | null;
};

export const emptyAssistantSettings: AssistantSettings = {
  apiKey: "",
  model: "",
  workingModels: [],
  latency: {},
  verifiedAt: null,
};

const STORAGE_KEY = "nexium.assistant.nim";

export function loadAssistantSettings(): AssistantSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);

    if (!raw) {
      return emptyAssistantSettings;
    }

    const parsed = JSON.parse(raw) as Partial<AssistantSettings>;
    const workingModels = Array.isArray(parsed.workingModels)
      ? parsed.workingModels.filter(
          (model): model is string => typeof model === "string",
        )
      : [];

    const latency: Record<string, number> = {};

    if (parsed.latency && typeof parsed.latency === "object") {
      for (const [id, ms] of Object.entries(parsed.latency)) {
        if (typeof ms === "number" && Number.isFinite(ms)) {
          latency[id] = ms;
        }
      }
    }

    return {
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : "",
      model: typeof parsed.model === "string" ? parsed.model : "",
      workingModels,
      latency,
      verifiedAt:
        typeof parsed.verifiedAt === "number" ? parsed.verifiedAt : null,
    };
  } catch {
    return emptyAssistantSettings;
  }
}

export function saveAssistantSettings(settings: AssistantSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Private mode or a full quota: the session still works without persistence.
  }
}
