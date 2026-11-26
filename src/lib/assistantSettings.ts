import { invoke, isTauri } from "./tauriBridge";

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

/**
 * Everything but the key goes to `localStorage`. In the desktop shell the key
 * goes to the OS credential store instead (Windows Credential Manager), so it
 * never sits in a plain file any page script could read. The browser-only dev
 * mode has no credential store and keeps the old behaviour.
 */
export function saveAssistantSettings(settings: AssistantSettings): void {
  const desktop = isTauri();

  try {
    const stored = desktop ? { ...settings, apiKey: "" } : settings;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // Private mode or a full quota: the session still works without persistence.
  }

  if (desktop) {
    invoke("secret_set_api_key", { key: settings.apiKey }).catch((cause) => {
      console.error("The API key could not be saved:", cause);
    });
  }
}

/**
 * Reads the key from the credential store, first moving a key that an older
 * build left in `localStorage` over to it. Returns null outside the desktop
 * shell or when no key is stored.
 */
export async function loadStoredApiKey(): Promise<string | null> {
  if (!isTauri()) {
    return null;
  }

  const legacy = loadAssistantSettings();

  if (legacy.apiKey) {
    try {
      await invoke("secret_set_api_key", { key: legacy.apiKey });
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ ...legacy, apiKey: "" }),
      );
    } catch (cause) {
      // Keep the old copy rather than lose the key.
      console.error("The API key could not be moved to the credential store:", cause);
      return legacy.apiKey;
    }
  }

  try {
    const key = await invoke<string | null>("secret_get_api_key");
    return key && key.trim() ? key : null;
  } catch (cause) {
    console.error("The API key could not be read:", cause);
    return null;
  }
}
