import { ToolError } from "./fs-safety.js";
import { log } from "./logger.js";

export type FetchLike = typeof fetch;

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
}

export interface ChatResult {
  content: string;
  finishReason: string | null;
  /** Zero-filled when the server reported nothing — check `usageKnown` first. */
  usage: Usage;
  /**
   * False when `usage` is absent, non-numeric or negative in the response body.
   * "Zero tokens" and "no measurement" are different facts, and anything scoring
   * a request against a context window has to be able to tell them apart.
   */
  usageKnown: boolean;
  model: string;
}

export interface ChatOptions {
  baseUrl: string;
  model: string;
  messages: ChatMessage[];
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  fetchImpl?: FetchLike;
}

async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ToolError(
        `LM Studio request timed out after ${timeoutMs} ms. Local models can be slow on large ` +
          `generations — raise LOCAL_CODER_TIMEOUT_MS or narrow the task.`,
        "llm_timeout",
        { timeout_ms: timeoutMs }
      );
    }
    throw new ToolError(
      `Could not reach LM Studio at ${url}: ${error instanceof Error ? error.message : String(error)}. ` +
        "Start LM Studio's server with `lms server start`.",
      "llm_unreachable",
      { url }
    );
  } finally {
    clearTimeout(timer);
  }
}

/** POST /chat/completions against the OpenAI-compatible endpoint. */
export async function chatCompletion(options: ChatOptions): Promise<ChatResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${options.baseUrl}/chat/completions`;
  const started = Date.now();
  const response = await fetchWithTimeout(
    fetchImpl,
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: options.model,
        messages: options.messages,
        temperature: options.temperature,
        max_tokens: options.maxTokens,
        stream: false,
      }),
    },
    options.timeoutMs
  );

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    throw new ToolError(
      `LM Studio returned HTTP ${response.status} for model ${JSON.stringify(options.model)}: ` +
        `${bodyText.slice(0, 500) || "(empty body)"}. ` +
        "Check that the model ID matches `lms ls` output and that JIT model loading is enabled.",
      "llm_http_error",
      { status: response.status, model: options.model }
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ToolError("LM Studio returned a non-JSON response body.", "llm_bad_response", {});
  }

  const body = payload as {
    choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }>;
    usage?: { prompt_tokens?: unknown };
    model?: unknown;
  };
  const choice = body.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== "string") {
    throw new ToolError(
      "LM Studio response had no assistant message content.",
      "llm_bad_response",
      {}
    );
  }
  log.debug(`chat completion finished in ${Date.now() - started} ms (finish_reason=${String(choice?.finish_reason ?? "?")})`);
  const promptRaw = body.usage?.prompt_tokens;
  const completionRaw = body.usage?.completion_tokens;
  const countable = (v: unknown): v is number =>
    typeof v === "number" && Number.isFinite(v) && v >= 0;
  return {
    content,
    finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : null,
    usage: {
      prompt_tokens: countable(promptRaw) ? promptRaw : 0,
      completion_tokens: countable(completionRaw) ? completionRaw : 0,
    },
    /**
     * Whether the server actually reported usable token counts. The zeroes above
     * are a summing convenience and must not be read as a measurement: a server
     * that omits `usage` — an older build, a proxy, a version skew — would
     * otherwise make every request look like it cost nothing, and
     * `contextExhausted(0, 0, window)` answers "fits" when the truth is "cannot
     * tell". B16 fails open on unknown, so the distinction has to survive
     * this far.
     */
    usageKnown: countable(promptRaw) && countable(completionRaw),
    model: typeof body.model === "string" ? body.model : options.model,
  };
}

/** GET /models — used by `status` for the reachability probe and model inventory. */
export async function listModels(
  baseUrl: string,
  timeoutMs: number,
  fetchImpl: FetchLike = fetch
): Promise<string[]> {
  const response = await fetchWithTimeout(fetchImpl, `${baseUrl}/models`, { method: "GET" }, timeoutMs);
  if (!response.ok) {
    throw new ToolError(
      `LM Studio returned HTTP ${response.status} from /models.`,
      "llm_http_error",
      { status: response.status }
    );
  }
  const payload = (await response.json().catch(() => null)) as {
    data?: Array<{ id?: unknown }>;
  } | null;
  if (!payload || !Array.isArray(payload.data)) {
    throw new ToolError("LM Studio /models response was not in the expected shape.", "llm_bad_response", {});
  }
  return payload.data
    .map((entry) => entry.id)
    .filter((id): id is string => typeof id === "string");
}
