export interface XrayCloudClientOptions {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  fetchFn?: typeof fetch;
}

export class XrayCloudClient {
  private readonly baseUrl: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly fetchFn: typeof fetch;
  private token: string | undefined;

  constructor(options: XrayCloudClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async graphql<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const token = await this.getToken();
    const response = await this.fetchFn(new URL("/api/v2/graphql", `${this.baseUrl}/`), {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables: variables ?? {} }),
    });

    if (!response.ok) {
      throw new Error(`Xray GraphQL ${response.status} ${response.statusText}: ${truncate(await safeResponseText(response), 1000)}`);
    }

    const payload = (await response.json()) as T;
    if (isRecord(payload) && Array.isArray(payload.errors) && payload.errors.length > 0) {
      throw new Error(`Xray GraphQL errors: ${JSON.stringify(payload.errors).slice(0, 1000)}`);
    }

    return payload;
  }

  private async getToken(): Promise<string> {
    if (this.token) {
      return this.token;
    }

    const response = await this.fetchFn(new URL("/api/v2/authenticate", `${this.baseUrl}/`), {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
    });

    if (!response.ok) {
      throw new Error(`Xray authenticate ${response.status} ${response.statusText}: ${truncate(await safeResponseText(response), 1000)}`);
    }

    const payload = await response.json();
    const token = typeof payload === "string" ? payload : isRecord(payload) && typeof payload.token === "string" ? payload.token : undefined;
    if (!token) {
      throw new Error("Xray authentication response did not include a token.");
    }

    this.token = token;
    return token;
  }
}

async function safeResponseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
