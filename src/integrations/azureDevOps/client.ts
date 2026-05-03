export interface AzureDevOpsClientOptions {
  token: string;
  fetchFn?: typeof fetch;
}

export class AzureDevOpsClient {
  private readonly token: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: AzureDevOpsClientOptions) {
    this.token = options.token;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async getJson(url: URL): Promise<unknown> {
    const response = await this.fetchFn(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${Buffer.from(`:${this.token}`, "utf8").toString("base64")}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Azure DevOps REST ${response.status} ${response.statusText}: ${await safeResponseText(response)}`);
    }

    if (response.status === 204) {
      return undefined;
    }

    return response.json();
  }

  async getText(url: URL): Promise<string> {
    const response = await this.fetchFn(url, {
      method: "GET",
      headers: {
        Accept: "text/plain",
        Authorization: `Basic ${Buffer.from(`:${this.token}`, "utf8").toString("base64")}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Azure DevOps REST ${response.status} ${response.statusText}: ${await safeResponseText(response)}`);
    }

    return response.text();
  }

  async postJson(url: URL, body: unknown): Promise<unknown> {
    const response = await this.fetchFn(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${Buffer.from(`:${this.token}`, "utf8").toString("base64")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Azure DevOps REST ${response.status} ${response.statusText}: ${await safeResponseText(response)}`);
    }

    if (response.status === 204) {
      return undefined;
    }

    return response.json();
  }
}

async function safeResponseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
