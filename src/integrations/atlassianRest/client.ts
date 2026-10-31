export type AtlassianRestService = "jira" | "confluence";

export interface AtlassianRestCredentials {
  baseUrl: string;
  username: string;
  apiToken: string;
}

export interface AtlassianRestClientOptions {
  jira: AtlassianRestCredentials;
  confluence?: AtlassianRestCredentials;
  fetchFn?: typeof fetch;
  /** Override for waiting between rate-limit retries, primarily for tests. */
  sleepFn?: (ms: number) => Promise<void>;
}

/** Retries after a 429/503 before giving up. */
const MAX_RETRIES = 3;
/** Upper bound for a single wait, whatever Retry-After asks for. */
const MAX_RETRY_DELAY_MS = 30_000;
const BASE_RETRY_DELAY_MS = 1_000;

export class AtlassianRestClient {
  private readonly jira: AtlassianRestCredentials;
  private readonly confluence: AtlassianRestCredentials | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly sleepFn: (ms: number) => Promise<void>;

  constructor(options: AtlassianRestClientOptions) {
    this.jira = normalizeCredentials(options.jira);
    this.confluence = options.confluence ? normalizeCredentials(options.confluence) : undefined;
    this.fetchFn = options.fetchFn ?? fetch;
    this.sleepFn = options.sleepFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async getJson(service: AtlassianRestService, path: string, query?: Record<string, string | number | boolean>): Promise<unknown> {
    const credentials = this.getCredentials(service);
    const url = new URL(path, `${credentials.baseUrl}/`);

    for (const [key, value] of Object.entries(query ?? {})) {
      url.searchParams.set(key, String(value));
    }

    const response = await this.send(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: basicAuth(credentials.username, credentials.apiToken),
      },
    });

    if (!response.ok) {
      throw new Error(`${service} REST ${response.status} ${response.statusText}: ${truncate(await safeResponseText(response), 500)}`);
    }

    return jsonOrUndefined(response);
  }

  async postJson(service: AtlassianRestService, path: string, body: unknown): Promise<unknown> {
    const credentials = this.getCredentials(service);
    const url = new URL(path, `${credentials.baseUrl}/`);

    const response = await this.send(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: basicAuth(credentials.username, credentials.apiToken),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`${service} REST ${response.status} ${response.statusText}: ${truncate(await safeResponseText(response), 500)}`);
    }

    return jsonOrUndefined(response);
  }

  async putJson(service: AtlassianRestService, path: string, body: unknown): Promise<unknown> {
    const credentials = this.getCredentials(service);
    const url = new URL(path, `${credentials.baseUrl}/`);

    const response = await this.send(url, {
      method: "PUT",
      headers: {
        Accept: "application/json",
        Authorization: basicAuth(credentials.username, credentials.apiToken),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`${service} REST ${response.status} ${response.statusText}: ${truncate(await safeResponseText(response), 500)}`);
    }

    return jsonOrUndefined(response);
  }

  /**
   * Fetch raw bytes (e.g. an attachment). Credentials are only attached when
   * the target shares the configured service origin, so a malicious/redirected
   * attachment URL on another host never receives the Atlassian token.
   */
  async getBinary(
    service: AtlassianRestService,
    urlOrPath: string,
  ): Promise<{ data: Uint8Array; contentType?: string }> {
    const credentials = this.getCredentials(service);
    const url = new URL(urlOrPath, `${credentials.baseUrl}/`);
    const sameOrigin = url.origin === new URL(credentials.baseUrl).origin;

    // `*/*`, not `application/octet-stream`: the Jira attachment-content
    // endpoint serves the file's real content type (e.g. image/png) and returns
    // 406 Not Acceptable for a narrow Accept. Accept anything so the bytes flow.
    const headers: Record<string, string> = { Accept: "*/*" };
    if (sameOrigin) {
      headers.Authorization = basicAuth(credentials.username, credentials.apiToken);
    }

    const response = await this.send(url, { method: "GET", headers });
    if (!response.ok) {
      throw new Error(`${service} REST ${response.status} ${response.statusText}: ${truncate(await safeResponseText(response), 500)}`);
    }

    const data = new Uint8Array(await response.arrayBuffer());
    const contentType = response.headers.get("content-type") ?? undefined;
    return { data, ...(contentType ? { contentType } : {}) };
  }

  hasConfluence(): boolean {
    return Boolean(this.confluence);
  }

  /**
   * `fetch` with bounded retry on rate limiting. 429 is retried for every
   * method (Jira did not process the request). 503 is retried only for
   * GET/PUT: a POST that hit 503 may have been applied, and re-sending it
   * could duplicate e.g. a comment. Honours Retry-After, else backs off
   * exponentially with jitter. The last response is returned either way, so
   * callers keep their existing error handling.
   */
  private async send(url: URL, init: RequestInit): Promise<Response> {
    const retryOn503 = init.method !== "POST";
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.fetchFn(url, init);
      const retryable = response.status === 429 || (retryOn503 && response.status === 503);
      if (!retryable || attempt >= MAX_RETRIES) {
        return response;
      }
      await safeResponseText(response);
      await this.sleepFn(retryDelayMs(response.headers.get("retry-after"), attempt));
    }
  }

  private getCredentials(service: AtlassianRestService): AtlassianRestCredentials {
    if (service === "jira") {
      return this.jira;
    }

    if (!this.confluence) {
      throw new Error("Confluence REST credentials are not configured");
    }

    return this.confluence;
  }
}

function normalizeCredentials(credentials: AtlassianRestCredentials): AtlassianRestCredentials {
  return {
    ...credentials,
    baseUrl: credentials.baseUrl.replace(/\/+$/, ""),
  };
}

function basicAuth(username: string, apiToken: string): string {
  return `Basic ${Buffer.from(`${username}:${apiToken}`, "utf8").toString("base64")}`;
}

async function safeResponseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

async function jsonOrUndefined(response: Response): Promise<unknown> {
  if (response.status === 204) {
    return undefined;
  }

  const text = await safeResponseText(response);
  return text.trim().length > 0 ? JSON.parse(text) : undefined;
}

function retryDelayMs(retryAfter: string | null, attempt: number): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(ms) && ms >= 0) return Math.min(ms, MAX_RETRY_DELAY_MS);
  }
  const backoff = BASE_RETRY_DELAY_MS * 2 ** attempt;
  return Math.min(backoff + Math.random() * backoff * 0.5, MAX_RETRY_DELAY_MS);
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}
