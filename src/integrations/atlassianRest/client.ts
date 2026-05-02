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
}

export class AtlassianRestClient {
  private readonly jira: AtlassianRestCredentials;
  private readonly confluence: AtlassianRestCredentials | undefined;
  private readonly fetchFn: typeof fetch;

  constructor(options: AtlassianRestClientOptions) {
    this.jira = normalizeCredentials(options.jira);
    this.confluence = options.confluence ? normalizeCredentials(options.confluence) : undefined;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async getJson(service: AtlassianRestService, path: string, query?: Record<string, string | number | boolean>): Promise<unknown> {
    const credentials = this.getCredentials(service);
    const url = new URL(path, `${credentials.baseUrl}/`);

    for (const [key, value] of Object.entries(query ?? {})) {
      url.searchParams.set(key, String(value));
    }

    const response = await this.fetchFn(url, {
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

    const response = await this.fetchFn(url, {
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

    const response = await this.fetchFn(url, {
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

  hasConfluence(): boolean {
    return Boolean(this.confluence);
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

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}
