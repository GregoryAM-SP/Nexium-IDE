/**
 * Chat providers the assistant can use. Every one speaks the OpenAI chat
 * completions API, so a provider is only a base URL, whether it needs a key,
 * and a note about its free offer.
 *
 * The list is the chat-capable part of "Free AI APIs — Complete Deduplicated
 * List" (verified Nov 8, 2026): core free providers, routers, trial-credit
 * providers and local servers. Image, audio, OCR, search, translation and
 * coding-IDE plans are not chat APIs, so they are not here. Providers whose
 * OpenAI-compatible base URL is not known ship without one; the user enters it
 * from the provider's docs.
 */

export type ProviderCategory = "free" | "router" | "trial" | "local";

export type ProviderPreset = {
  id: string;
  name: string;
  category: ProviderCategory;
  /** OpenAI-compatible base URL (ending before /chat/completions), if known. */
  baseUrl: string | null;
  /** "required", "optional" (anonymous tier exists) or "none" (local). */
  key: "required" | "optional" | "none";
  /** Where to create a key or read the docs. */
  docsUrl?: string;
  /** The free offer, in a line. */
  note: string;
  /** Things to know before relying on it. */
  caution?: string;
};

export const SOURCE_NOTE =
  "Free-tier details come from a list verified Nov 8, 2026. Free tiers change often — check the provider's pricing before relying on one.";

export const CATEGORY_LABEL: Record<ProviderCategory, string> = {
  free: "Free tier",
  router: "Router",
  trial: "Trial credit",
  local: "Local",
};

export const PROVIDERS: ProviderPreset[] = [
  // ── Core chat APIs with a permanent free tier ───────────────────────────
  {
    id: "nvidia",
    name: "NVIDIA NIM",
    category: "free",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    key: "required",
    docsUrl: "https://build.nvidia.com/settings/api-keys",
    note: "Free endpoint models (GLM, Nemotron, Gemma, Llama Vision). No card.",
  },
  {
    id: "google",
    name: "Google AI Studio (Gemini)",
    category: "free",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    key: "required",
    docsUrl: "https://aistudio.google.com/apikey",
    note: "Per-model free tier: Gemini Flash, Gemma. No card. Long context.",
    caution: "Free-tier prompts may be used for training outside the UK/EEA.",
  },
  {
    id: "groq",
    name: "Groq",
    category: "free",
    baseUrl: "https://api.groq.com/openai/v1",
    key: "required",
    docsUrl: "https://console.groq.com/keys",
    note: "Free plan with per-model rate limits, very fast. No card.",
  },
  {
    id: "cerebras",
    name: "Cerebras",
    category: "free",
    baseUrl: "https://api.cerebras.ai/v1",
    key: "required",
    docsUrl: "https://cloud.cerebras.ai",
    note: "Free tier with fast inference, historically 1M tokens/day.",
  },
  {
    id: "cloudflare",
    name: "Cloudflare Workers AI",
    category: "free",
    baseUrl: "https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/ai/v1",
    key: "required",
    docsUrl: "https://dash.cloudflare.com",
    note: "10,000 Neurons/day free. No card. Replace ACCOUNT_ID in the URL.",
  },
  {
    id: "mistral",
    name: "Mistral",
    category: "free",
    baseUrl: "https://api.mistral.ai/v1",
    key: "required",
    docsUrl: "https://console.mistral.ai",
    note: "Free mode with a shared monthly allowance. No card.",
    caution: "Free-mode prompts may be used for training.",
  },
  {
    id: "cohere",
    name: "Cohere",
    category: "free",
    baseUrl: "https://api.cohere.ai/compatibility/v1",
    key: "required",
    docsUrl: "https://dashboard.cohere.com/api-keys",
    note: "Trial keys never expire, 1,000 calls/month. No card.",
    caution: "Trial keys are not for production or commercial use.",
  },
  {
    id: "huggingface",
    name: "Hugging Face Inference",
    category: "free",
    baseUrl: "https://router.huggingface.co/v1",
    key: "required",
    docsUrl: "https://huggingface.co/settings/tokens",
    note: "Free community tier, credit-metered, through the Router API.",
  },
  {
    id: "kilo",
    name: "Kilo Code Gateway",
    category: "free",
    baseUrl: "https://api.kilo.ai/api/gateway",
    key: "optional",
    note: "Free model pool, about 200 requests/hour. Works without a key.",
    caution: "Free routes may use prompts for training.",
  },
  {
    id: "llm7",
    name: "LLM7.io",
    category: "free",
    baseUrl: "https://api.llm7.io/v1",
    key: "optional",
    note: "100,000 tokens/day on eligible models with a free dashboard token.",
  },
  {
    id: "pollinations",
    name: "Pollinations.AI",
    category: "free",
    baseUrl: null,
    key: "required",
    note: "Free text, image and audio API. A key is now required.",
    caution: "The legacy no-key endpoint is throttled; use the current OpenAI-compatible URL from its docs.",
  },
  {
    id: "ovh",
    name: "OVHcloud AI Endpoints",
    category: "free",
    baseUrl: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1",
    key: "optional",
    note: "Anonymous free tier, 2 requests/minute per model. EU-hosted.",
  },
  {
    id: "zai",
    name: "Z.ai (Zhipu GLM)",
    category: "free",
    baseUrl: "https://api.z.ai/api/paas/v4",
    key: "required",
    note: "GLM Flash models free, vision included. No card.",
  },
  {
    id: "sambanova",
    name: "SambaNova Cloud",
    category: "free",
    baseUrl: "https://api.sambanova.ai/v1",
    key: "required",
    note: "Free tier on open models. Registration required.",
  },
  {
    id: "siliconflow",
    name: "SiliconFlow (China)",
    category: "free",
    baseUrl: "https://api.siliconflow.cn/v1",
    key: "required",
    note: "Zero-priced small chat models.",
    caution: "Real-name verification required.",
  },
  {
    id: "modelscope",
    name: "ModelScope API-Inference",
    category: "free",
    baseUrl: "https://api-inference.modelscope.cn/v1",
    key: "required",
    note: "2,000 requests/day in total.",
    caution: "Needs an Alibaba Cloud binding and real-name verification.",
  },
  {
    id: "dashscope",
    name: "Alibaba Model Studio (DashScope Intl)",
    category: "free",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    key: "required",
    note: "Per-model free token grants, typically 1M tokens for 90 days.",
  },
  {
    id: "sealion",
    name: "SEA-LION (AI Singapore)",
    category: "free",
    baseUrl: "https://api.sea-lion.ai/v1",
    key: "required",
    note: "Free API for Southeast Asian language models. No card.",
  },
  {
    id: "typhoon",
    name: "OpenTyphoon (SCB 10X)",
    category: "free",
    baseUrl: "https://api.opentyphoon.ai/v1",
    key: "required",
    note: "Free research showcase of Thai-tuned models.",
    caution: "Prompts may be used for training.",
  },
  {
    id: "ollama-cloud",
    name: "Ollama Cloud",
    category: "free",
    baseUrl: "https://ollama.com/v1",
    key: "required",
    note: "Monthly starter allowance; pay-as-you-go in places.",
  },
  {
    id: "novita",
    name: "Novita AI",
    category: "free",
    baseUrl: "https://api.novita.ai/openai",
    key: "required",
    note: "A zero-priced chat model with tool calling. No card.",
  },
  {
    id: "aion",
    name: "Aion Labs",
    category: "free",
    baseUrl: "https://api.aionlabs.ai/v1",
    key: "required",
    note: "Daily credit allowance on the $0 plan. No card.",
  },
  {
    id: "arli",
    name: "Arli AI",
    category: "free",
    baseUrl: "https://api.arliai.com/v1",
    key: "required",
    note: "Each model 5 times every 2 days, 12K context, one request at a time.",
  },
  ...[
    ["hetzner", "Hetzner Inference API", "Free while the experiment runs, EU hardware."],
    ["iteracompute", "IteraCompute", "Recurring free usage on a self-hosted open model."],
    ["simplellm", "SimpleLLM", "Zero-price model aliases (Gemma, Llama 3.1 8B)."],
    ["agnes", "Agnes AI", "Flash text models at zero price today."],
    ["freeinference", "FreeInference (Harvard SEAS)", "Free to every account; OpenAI-style endpoint."],
    ["bytez", "Bytez", "$1 credit every 4 weeks for open models up to 7B."],
    ["mixlayer", "Mixlayer", "One model at $0 without prepaid credit."],
    ["sensenova", "SenseNova (SenseTime)", "$0 plan during public beta. Mainland China only."],
    ["tencent", "Tencent Cloud TokenHub", "1M tokens per model, once, valid a year. China/HK/TW/Macao."],
    ["plamo", "PLaMo API (Preferred Networks)", "Free plan for eligible users in Japan."],
    ["vlmrun", "VLM Run Gateway", "Anonymous beta; recently started asking for a key."],
    ["zro", "Zro (MoonMath)", "Recurring free plan on selected Flash models. Provisional."],
    ["merkium", "Merkium", "Free OpenAI-compatible API, no per-request charge for now."],
    ["llmkiwi", "LLM.kiwi", "No-card free plan with an automatic router. Provisional."],
    ["miapi", "MIAPI", "Monthly free allowance for web-grounded answers. Provisional."],
    ["infron", "Infron", "Shared free allowance after a $5 one-time top-up."],
  ].map(
    ([id, name, note]): ProviderPreset => ({
      id,
      name,
      category: "free",
      baseUrl: null,
      key: "required",
      note,
    }),
  ),

  // ── Routers: one key, many providers ────────────────────────────────────
  {
    id: "openrouter",
    name: "OpenRouter",
    category: "router",
    baseUrl: "https://openrouter.ai/api/v1",
    key: "required",
    docsUrl: "https://openrouter.ai/keys",
    note: ":free models at 20 requests/minute, 50/day (1,000/day after buying credits).",
    caution: "Free providers may log prompts.",
  },
  {
    id: "requesty",
    name: "Requesty",
    category: "router",
    baseUrl: "https://router.requesty.ai/v1",
    key: "required",
    note: "200 requests/day on free models. No card.",
  },
  {
    id: "aihubmix",
    name: "AIHubMix",
    category: "router",
    baseUrl: "https://aihubmix.com/v1",
    key: "required",
    note: "Zero-priced routes for GLM, Kimi, MiniMax, Nemotron, Gemma.",
  },
  {
    id: "vercel",
    name: "Vercel AI Gateway",
    category: "router",
    baseUrl: "https://ai-gateway.vercel.sh/v1",
    key: "required",
    note: "$5/month credit plus zero-priced routes.",
    caution: "The team needs a payment method on file, or requests fail with 403.",
  },
  {
    id: "airforce",
    name: "Api.Airforce",
    category: "router",
    baseUrl: "https://api.airforce/v1",
    key: "required",
    note: "Free models through a gateway. Key required.",
  },
  ...[
    ["routeway", "Routeway", "Rotating :free chat-model lane."],
    ["llmtr", "LLMTR", "Free models on a zero balance (Turkish gateway)."],
    ["bazaarlink", "BazaarLink", "Shared free allowance plus an auto:free router."],
    ["inferbase", "Inferbase", "Permanent $0 plan with a shared daily budget."],
    ["nous", "Nous Portal", "$0 plan for :free models."],
    ["tokenharbor", "Token Harbor", "Rotating :free ids, allowance per rolling 7 days."],
    ["tokenrouter", "TokenRouter (PaleBlueDot)", "Zero-priced free-model route."],
    ["opper", "Opper", "Free route before adding a card; docs conflict."],
    ["meganova", "MegaNova", "Daily free quotas on the no-card tier."],
    ["moark", "Moark (Gitee AI)", "100 calls/day across featured models."],
    ["kiosapi", "Kiosapi.id", "Daily free allowance (Indonesian gateway)."],
    ["novai", "NovAI", "Recurring free allowance on text and vision models."],
    ["oneminai", "1min.AI", "No-card free plan; the API spends the same credits."],
    ["orcarouter", "OrcaRouter", "Free models for accounts linked to GitHub."],
    ["anyapi", "AnyAPI", "Free model API plus a daily token allowance."],
    ["beatapi", "BeatAPI", "Free text-model variants without a top-up."],
    ["experiential", "Experiential Labs", "Free core-model pool after a $1 card check."],
    ["jzs", "JZS Token", "Temporary free model API after a $1.50 top-up."],
    ["coderplan", "CoderPlan", "Sign-up bonus on an OpenAI-compatible gateway."],
    ["unorouter", "UnoRouter", "Large catalogue of :free routes, shared capacity."],
  ].map(
    ([id, name, note]): ProviderPreset => ({
      id,
      name,
      category: "router",
      baseUrl: null,
      key: "required",
      note,
    }),
  ),

  // ── Trial or one-time credit ────────────────────────────────────────────
  {
    id: "xai",
    name: "xAI",
    category: "trial",
    baseUrl: "https://api.x.ai/v1",
    key: "required",
    docsUrl: "https://console.x.ai",
    note: "Free credits on signup, then pay-as-you-go.",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    category: "trial",
    baseUrl: "https://api.deepseek.com/v1",
    key: "required",
    docsUrl: "https://platform.deepseek.com/api_keys",
    note: "Starter grant of about 5M tokens, then low per-token prices.",
  },
  {
    id: "ai21",
    name: "AI21 Labs",
    category: "trial",
    baseUrl: "https://api.ai21.com/studio/v1",
    key: "required",
    note: "$10 initial developer credit.",
  },
  {
    id: "upstage",
    name: "Upstage Solar",
    category: "trial",
    baseUrl: "https://api.upstage.ai/v1",
    key: "required",
    note: "$10 credit on signup, no card.",
  },
  {
    id: "inception",
    name: "Inception Labs (Mercury)",
    category: "trial",
    baseUrl: "https://api.inceptionlabs.ai/v1",
    key: "required",
    note: "One-time signup token balance. Mercury chat and code-edit models.",
  },
  {
    id: "fireworks",
    name: "Fireworks AI",
    category: "trial",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    key: "required",
    note: "Small trial credit.",
  },
  {
    id: "regolo",
    name: "Regolo AI",
    category: "trial",
    baseUrl: "https://api.regolo.ai/v1",
    key: "required",
    note: "One month of access with a daily allowance. EU, zero retention.",
  },
  ...[
    ["sarvam", "Sarvam AI", "Credits that never expire, for verified users."],
    ["hpcai", "HPC-AI Model APIs", "$2 signup credit."],
    ["routerplex", "RouterPlex", "$1 one-time credit, list prices."],
    ["wallaby", "Wallaby", "$0.50 signup credit (Kimi from an Australian gateway)."],
    ["abliteration", "abliteration.ai", "One-credit free preview."],
    ["impossibl", "Impossibl", "$0.05 without a key plus $1 once claimed by email."],
    ["notrack", "NoTrack API", "First-key trial budget."],
    ["standardcompute", "Standard Compute", "$0.25 one-time smart-routed compute."],
    ["dahl", "Dahl Inference", "100M tokens on signup."],
    ["thegrid", "The Grid", "$25 signup credit for a limited time."],
    ["vertex-express", "Vertex AI Express", "90 days with an API key for new Google Cloud users."],
    ["sail", "Sail Research", "$5 monthly credit once a card is on file."],
  ].map(
    ([id, name, note]): ProviderPreset => ({
      id,
      name,
      category: "trial",
      baseUrl: null,
      key: "required",
      note,
    }),
  ),

  // ── Local servers: free, unlimited, private ─────────────────────────────
  {
    id: "ollama",
    name: "Ollama",
    category: "local",
    baseUrl: "http://localhost:11434/v1",
    key: "none",
    docsUrl: "https://ollama.com",
    note: "Open-source, unlimited and offline. Start Ollama, then load models.",
  },
  {
    id: "lmstudio",
    name: "LM Studio",
    category: "local",
    baseUrl: "http://localhost:1234/v1",
    key: "none",
    docsUrl: "https://lmstudio.ai",
    note: "Free for personal use; run any GGUF/MLX model. Start its server first.",
  },
  {
    id: "llamacpp",
    name: "llama.cpp server",
    category: "local",
    baseUrl: "http://localhost:8080/v1",
    key: "none",
    note: "Open-source GGUF inference on CPU or GPU.",
  },
  {
    id: "gpt4all",
    name: "GPT4All",
    category: "local",
    baseUrl: "http://localhost:4891/v1",
    key: "none",
    note: "Open-source local inference on the CPU.",
  },
  {
    id: "jan",
    name: "Jan",
    category: "local",
    baseUrl: "http://localhost:1337/v1",
    key: "none",
    note: "Open-source desktop app with a local API server.",
  },
];

const BY_ID = new Map(PROVIDERS.map((preset) => [preset.id, preset]));

export function presetFor(id: string): ProviderPreset | undefined {
  return BY_ID.get(id);
}

/** A rough "is this a sensible base URL" check, mirrored strictly in Rust. */
export function baseUrlProblem(url: string): string | null {
  const trimmed = url.trim();

  if (!trimmed) {
    return "Enter the provider's OpenAI-compatible base URL.";
  }

  if (trimmed.includes("ACCOUNT_ID")) {
    return "Replace ACCOUNT_ID with your account ID.";
  }

  let parsed: URL;

  try {
    parsed = new URL(trimmed);
  } catch {
    return "That is not a valid URL.";
  }

  const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);

  if (parsed.protocol === "https:" || (parsed.protocol === "http:" && local)) {
    return null;
  }

  return parsed.protocol === "http:"
    ? "Use https:// — plain http is only allowed for localhost."
    : "The URL must start with https://.";
}
