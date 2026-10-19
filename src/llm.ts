// Minimal OpenAI-compatible chat client. One interface covers OpenRouter,
// OpenAI, DeepSeek, Mistral, Together, DeepInfra, Gemini (compat endpoint),
// Groq and local servers (Ollama, llama.cpp, vLLM). No SDK, no vendor lock-in.

export interface LlmConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  maxTokens?: number;
  timeoutMs?: number;
  /** ask for response_format=json_object (not every provider supports it) */
  jsonMode?: boolean;
  /** some newer OpenAI models require max_completion_tokens and reject temperature */
  openaiStyle?: boolean;
  /** USD per million tokens; if absent, provider-reported cost (OpenRouter) is used when present */
  priceInPerM?: number;
  priceOutPerM?: number;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  /** retry tuning (free models are often rate-limited and need longer waits) */
  maxAttempts?: number;
  retryBaseMs?: number;
  retryCapMs?: number;
}

export interface Usage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

export const PROVIDERS: Record<string, string> = {
  openrouter: "https://openrouter.ai/api/v1",
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com",
  mistral: "https://api.mistral.ai/v1",
  together: "https://api.together.xyz/v1",
  deepinfra: "https://api.deepinfra.com/v1/openai",
  groq: "https://api.groq.com/openai/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
  nvidia: "https://integrate.api.nvidia.com/v1", // build.nvidia.com (keys start with nvapi-)
  ollama: "http://localhost:11434/v1",
};

export interface ConfigInput {
  provider?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  priceIn?: number;
  priceOut?: number;
  jsonMode?: boolean;
}

/** Build a config from explicit values, falling back to LLM_* environment variables. */
export function resolveConfig(input: ConfigInput = {}, env: Record<string, string | undefined> = process.env): LlmConfig {
  const provider = input.provider ?? env.LLM_PROVIDER;
  const baseUrl = input.baseUrl ?? env.LLM_BASE_URL ?? (provider ? PROVIDERS[provider] : undefined);
  const model = input.model ?? env.LLM_MODEL;
  if (!baseUrl) throw new Error(`no LLM endpoint: set --provider (${Object.keys(PROVIDERS).join("|")}) or --base-url / LLM_BASE_URL`);
  if (!model) throw new Error("no model: set --model or LLM_MODEL");
  const apiKey = input.apiKey ?? env.LLM_API_KEY;
  if (!apiKey && !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(baseUrl)) {
    throw new Error("no API key: set LLM_API_KEY (a local endpoint such as Ollama needs none)");
  }
  const priceIn = input.priceIn ?? (env.LLM_PRICE_IN ? Number(env.LLM_PRICE_IN) : undefined);
  const priceOut = input.priceOut ?? (env.LLM_PRICE_OUT ? Number(env.LLM_PRICE_OUT) : undefined);
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    model,
    ...(apiKey ? { apiKey } : {}),
    ...(priceIn !== undefined ? { priceInPerM: priceIn } : {}),
    ...(priceOut !== undefined ? { priceOutPerM: priceOut } : {}),
    ...(input.jsonMode ? { jsonMode: true } : {}),
    ...(provider === "openai" ? { openaiStyle: true } : {}),
    // free / trial endpoints rate-limit hard: wait longer instead of failing
    ...(provider === "nvidia" ? { maxAttempts: 6, retryCapMs: 30000 } : {}),
    headers: { "X-Title": "BehaviorDiff" },
  };
}

export const emptyUsage = (): Usage => ({ calls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function chat(cfg: LlmConfig, messages: Message[]): Promise<{ text: string; usage: Usage }> {
  const f = cfg.fetchImpl ?? fetch;
  const body: Record<string, unknown> = { model: cfg.model, messages };
  const limit = cfg.maxTokens ?? 1000;
  if (cfg.openaiStyle) body.max_completion_tokens = limit;
  else (body.max_tokens = limit, (body.temperature = 0));
  if (cfg.jsonMode) body.response_format = { type: "json_object" };
  if (cfg.baseUrl.includes("openrouter.ai")) body.usage = { include: true }; // report real cost per call

  let lastErr = "";
  const free = cfg.model.endsWith(":free");
  const attempts = cfg.maxAttempts ?? (free ? 6 : 4);
  const baseMs = cfg.retryBaseMs ?? 1000;
  const capMs = cfg.retryCapMs ?? (free ? 30000 : 8000);
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt) await sleep(Math.min(capMs, baseMs * 2 ** (attempt - 1)));
    let res: Response;
    try {
      res = await f(`${cfg.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
          ...cfg.headers,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(cfg.timeoutMs ?? 90000),
      });
    } catch (e) {
      lastErr = `network error: ${(e as Error).message}`;
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      let detail = "";
      try {
        const j = JSON.parse(await res.text());
        detail = String(j?.error?.message ?? "").slice(0, 200).replace(cfg.apiKey ?? "\u0000", "***");
        const prov = j?.error?.metadata?.provider_name;
        if (prov) detail += ` [provider ${prov}]`;
      } catch {
        /* body not JSON */
      }
      lastErr = `HTTP ${res.status}${detail ? ": " + detail : ""}`;
      const ra = Number(res.headers.get("retry-after"));
      if (ra > 0 && ra <= 20) await sleep(Math.min(ra * 1000, capMs));
      continue;
    }
    const raw = await res.text();
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${raw.slice(0, 300).replace(cfg.apiKey ?? "\u0000", "***")}`);
    let j: any;
    try {
      j = JSON.parse(raw);
    } catch {
      throw new Error(`LLM returned non-JSON: ${raw.slice(0, 200)}`);
    }
    const c = j?.choices?.[0]?.message?.content;
    const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((p: any) => p?.text ?? "").join("") : "";
    const promptTokens = Number(j?.usage?.prompt_tokens ?? 0);
    const completionTokens = Number(j?.usage?.completion_tokens ?? 0);
    let costUsd = 0;
    if (cfg.priceInPerM !== undefined || cfg.priceOutPerM !== undefined) {
      costUsd = (promptTokens * (cfg.priceInPerM ?? 0) + completionTokens * (cfg.priceOutPerM ?? 0)) / 1e6;
    } else if (typeof j?.usage?.cost === "number") {
      costUsd = j.usage.cost;
    }
    return { text, usage: { calls: 1, promptTokens, completionTokens, costUsd } };
  }
  throw new Error(`LLM request failed after retries (${lastErr})`);
}

export function addUsage(a: Usage, b: Usage): void {
  a.calls += b.calls;
  a.promptTokens += b.promptTokens;
  a.completionTokens += b.completionTokens;
  a.costUsd += b.costUsd;
}
