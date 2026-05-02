export interface PostOpenAiResponsesOptions {
  apiKey: string;
  baseUrl: string;
  body: unknown;
  fetchFn?: typeof fetch;
  maxAttempts?: number;
  sleepFn?: (milliseconds: number) => Promise<void>;
  onRetry?: (message: string) => void;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_INITIAL_RETRY_DELAY_MS = 2_000;
const MAX_RETRY_DELAY_MS = 120_000;

export async function postOpenAiResponses(options: PostOpenAiResponsesOptions): Promise<unknown> {
  const fetchFn = options.fetchFn ?? fetch;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const sleepFn = options.sleepFn ?? sleep;
  const onRetry = options.onRetry ?? ((message: string) => console.error(message));
  const url = `${options.baseUrl.replace(/\/+$/, "")}/responses`;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchFn(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(options.body),
      });

      if (response.ok) {
        return response.json();
      }

      const responseText = await safeResponseText(response);
      if (attempt < maxAttempts && shouldRetry(response.status, responseText)) {
        const delayMs = retryDelayMs(response, responseText, attempt);
        onRetry(formatRetryMessage(response.status, response.statusText, attempt, maxAttempts, delayMs));
        await sleepFn(delayMs);
        continue;
      }

      throw new Error(`OpenAI Responses API ${response.status} ${response.statusText}: ${responseText}`);
    } catch (error) {
      if (attempt < maxAttempts && isRetryableFetchError(error)) {
        const delayMs = retryDelayMs(undefined, undefined, attempt);
        onRetry(formatRetryMessage("network", error instanceof Error ? error.message : String(error), attempt, maxAttempts, delayMs));
        await sleepFn(delayMs);
        continue;
      }

      throw error;
    }
  }

  throw new Error("OpenAI Responses API retry loop exhausted unexpectedly.");
}

export function extractOutputText(payload: unknown): string {
  if (isRecord(payload) && typeof payload.output_text === "string") {
    return payload.output_text;
  }

  if (!isRecord(payload) || !Array.isArray(payload.output)) {
    throw new Error("OpenAI response did not include output text.");
  }

  const parts: string[] = [];
  for (const item of payload.output) {
    if (!isRecord(item) || !Array.isArray(item.content)) {
      continue;
    }

    for (const content of item.content) {
      if (isRecord(content) && typeof content.text === "string") {
        parts.push(content.text);
      }
    }
  }

  const text = parts.join("\n").trim();
  if (!text) {
    throw new Error("OpenAI response text was empty.");
  }

  return text;
}

export function parseJsonObject(text: string): unknown {
  const trimmed = text.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  return JSON.parse(trimmed);
}

function shouldRetry(status: number, responseText: string): boolean {
  if ([408, 409, 429, 500, 502, 503, 504].includes(status)) {
    return true;
  }

  const payload = parseJson(responseText);
  return isRecord(payload) && payload.retryable === true;
}

function isRetryableFetchError(error: unknown): boolean {
  return error instanceof TypeError || error instanceof DOMException;
}

function retryDelayMs(response: Response | undefined, responseText: string | undefined, attempt: number): number {
  const retryAfter = retryAfterMs(response, responseText);
  if (retryAfter !== undefined) {
    return Math.min(retryAfter, MAX_RETRY_DELAY_MS);
  }

  return Math.min(DEFAULT_INITIAL_RETRY_DELAY_MS * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);
}

function retryAfterMs(response: Response | undefined, responseText: string | undefined): number | undefined {
  const headerValue = response?.headers.get("retry-after");
  const fromHeader = parseRetryAfterValue(headerValue);
  if (fromHeader !== undefined) {
    return fromHeader;
  }

  const payload = responseText ? parseJson(responseText) : undefined;
  if (!isRecord(payload)) {
    return undefined;
  }

  return parseRetryAfterValue(payload.retry_after);
}

function parseRetryAfterValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value * 1000;
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }

  const asSeconds = Number(value);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return asSeconds * 1000;
  }

  const asDate = new Date(value);
  if (!Number.isNaN(asDate.getTime())) {
    return Math.max(asDate.getTime() - Date.now(), 0);
  }

  return undefined;
}

function formatRetryMessage(status: number | "network", detail: string, attempt: number, maxAttempts: number, delayMs: number): string {
  const delaySeconds = (delayMs / 1000).toFixed(1);
  return `[openai:responses] Attempt ${attempt}/${maxAttempts} failed (${status} ${detail}). Retrying in ${delaySeconds}s.`;
}

async function safeResponseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
