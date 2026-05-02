import type {
  Attachment,
  Branch,
  Comment,
  ConfluencePage,
  Development,
  Person,
  PullRequest,
  TicketLink,
  ToolProvenance,
  Warning,
} from "../../domain/contextPack/schema.js";
import type { NormalizedIssue } from "../../domain/tickets/normalizedIssue.js";
import { asArray, firstPresent, firstString, isRecord, toIsoString, uniqueBy, unknownToText } from "../../shared/utils.js";
import type { TicketSource } from "../../workflows/ticket-context/ticketSource.js";
import { normalizeAttachments, normalizeComments, normalizeIssue, normalizeLinkedIssues } from "../atlassian/normalizers.js";
import type { AtlassianRestClient } from "./client.js";

interface AtlassianRestSourceOptions {
  client: AtlassianRestClient;
  jiraCloudId?: string;
}

interface CachedIssue {
  raw: unknown;
  normalized: NormalizedIssue;
}

export class AtlassianRestSource implements TicketSource {
  private readonly client: AtlassianRestClient;
  private cachedCloudId: string | undefined;
  private readonly issueCache = new Map<string, CachedIssue>();
  private readonly provenance: ToolProvenance[] = [];
  private readonly warnings: Warning[] = [];

  constructor(options: AtlassianRestSourceOptions) {
    this.client = options.client;
    this.cachedCloudId = options.jiraCloudId;
  }

  getSourceName(): "jira-rest" {
    return "jira-rest";
  }

  async getIssue(issueKey: string): Promise<NormalizedIssue> {
    return (await this.getCachedIssue(issueKey)).normalized;
  }

  async getComments(issueKey: string): Promise<Comment[]> {
    const comments: unknown[] = [];
    let startAt = 0;
    const maxResults = 100;

    while (true) {
      const page = await this.callRest("getComments", "jira:issue-comments", () =>
        this.client.getJson("jira", `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, {
          startAt,
          maxResults,
          expand: "renderedBody",
        }),
      );

      if (!isRecord(page)) {
        break;
      }

      const values = Array.isArray(page.comments) ? page.comments : [];
      comments.push(...values);

      const total = typeof page.total === "number" ? page.total : comments.length;
      startAt += values.length;

      if (values.length === 0 || startAt >= total) {
        break;
      }
    }

    return normalizeComments({ comments });
  }

  async getAttachments(issueKey: string): Promise<Attachment[]> {
    const issue = await this.getCachedIssue(issueKey);
    return normalizeAttachments(issue.raw);
  }

  async getLinkedIssues(issueKey: string): Promise<TicketLink[]> {
    const issue = await this.getCachedIssue(issueKey);
    return normalizeLinkedIssues(issue.raw, issueKey);
  }

  async getDevelopmentLinks(issueKey: string): Promise<Development> {
    const issue = await this.getCachedIssue(issueKey);
    const issueId = firstString(issue.raw, ["id"]);

    if (!issueId) {
      this.addWarning("development", "jira-graphql:developmentInformation", `Could not resolve numeric Jira issue id for ${issueKey}`);
      return { branches: [], pullRequests: [] };
    }

    return (await this.tryGetGraphqlDevelopment(issueId)) ?? { branches: [], pullRequests: [] };
  }

  async getConfluencePages(issueKey: string): Promise<ConfluencePage[]> {
    const remoteLinks = await this.callRest("getConfluencePages", "jira-rest:remote-links", () =>
      this.client.getJson("jira", `/rest/api/3/issue/${encodeURIComponent(issueKey)}/remotelink`),
    );

    const linkedPages = normalizeConfluenceRemoteLinks(remoteLinks);
    const hydratedPages: ConfluencePage[] = [];

    for (const page of linkedPages) {
      const pageId = page.id ?? parseConfluencePageId(page.url);

      if (!pageId || !this.client.hasConfluence()) {
        hydratedPages.push(page);
        continue;
      }

      try {
        const details = await this.callRest("getConfluencePage", "confluence-rest:content", () =>
          this.client.getJson("confluence", `/rest/api/content/${encodeURIComponent(pageId)}`, {
            expand: "body.storage,version,space",
          }),
        );
        hydratedPages.push(mergeConfluencePage(page, normalizeConfluenceContent(details, page.url)));
      } catch (error) {
        this.addWarning("confluencePages", "confluence-rest:content", `Could not hydrate Confluence page ${pageId}: ${errorMessage(error)}`);
        hydratedPages.push(page);
      }
    }

    return uniqueBy(hydratedPages, (page) => page.url ?? page.id ?? page.title);
  }

  getProvenance(): ToolProvenance[] {
    return [...this.provenance];
  }

  getWarnings(): Warning[] {
    return [...this.warnings];
  }

  async close(): Promise<void> {
    return undefined;
  }

  private async tryGetGraphqlDevelopment(issueId: string): Promise<Development | undefined> {
    const cloudId = await this.resolveCloudId();
    if (!cloudId) {
      return undefined;
    }

    const issueAri = buildIssueAri(cloudId, issueId);

    try {
      const response = await this.callRest("getDevelopmentLinks", "jira-graphql:developmentInformation", () =>
        this.client.postJson("jira", "/gateway/api/graphql", buildDevelopmentInfoRequest(issueAri)),
      );

      const errors = firstPresent(response, ["errors"]);
      if (Array.isArray(errors) && errors.length > 0) {
        this.addWarning("development", "jira-graphql:developmentInformation", summarizeGraphqlErrors(errors));
        return undefined;
      }

      const developmentInformation = firstPresent(response, ["data.developmentInformation"]);
      if (!isRecord(developmentInformation)) {
        return { branches: [], pullRequests: [] };
      }

      return normalizeGraphqlDevelopment(developmentInformation);
    } catch (error) {
      this.addWarning(
        "development",
        "jira-graphql:developmentInformation",
        `${errorMessage(error)}. GraphQL developmentInformation data unavailable.`,
      );
      return undefined;
    }
  }

  private async resolveCloudId(): Promise<string | undefined> {
    if (this.cachedCloudId) {
      return this.cachedCloudId;
    }

    try {
      const tenantInfo = await this.callRest("getCloudId", "jira-rest:tenant-info", () =>
        this.client.getJson("jira", "/_edge/tenant_info"),
      );
      const cloudId = firstString(tenantInfo, ["cloudId"]);

      if (cloudId) {
        this.cachedCloudId = cloudId;
        return cloudId;
      }

      this.addWarning("development", "jira-rest:tenant-info", "Tenant info response did not include cloudId.");
    } catch (error) {
      this.addWarning(
        "development",
        "jira-rest:tenant-info",
        `${errorMessage(error)}. Set JIRA_CLOUD_ID to enable Jira GraphQL developmentInformation.`,
      );
    }

    return undefined;
  }

  private async getCachedIssue(issueKey: string): Promise<CachedIssue> {
    const cached = this.issueCache.get(issueKey);
    if (cached) {
      return cached;
    }

    const raw = await this.callRest("getIssue", "jira-rest:issue", () =>
      this.client.getJson("jira", `/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
        fields: "*all",
        expand: "renderedFields,names,schema",
      }),
    );
    const normalized = normalizeIssue(raw, issueKey);
    const cachedIssue = { raw, normalized };
    this.issueCache.set(issueKey, cachedIssue);
    return cachedIssue;
  }

  private async callRest(method: string, toolName: string, action: () => Promise<unknown>): Promise<unknown> {
    const calledAt = new Date().toISOString();

    try {
      const result = await action();
      this.provenance.push({ method, toolName, calledAt, success: true });
      return result;
    } catch (error) {
      const message = errorMessage(error);
      this.provenance.push({ method, toolName, calledAt, success: false, message });
      throw error;
    }
  }

  private addWarning(section: string, toolName: string, message: string): void {
    this.warnings.push({ section, toolName, message });
  }
}

function normalizeConfluenceRemoteLinks(raw: unknown): ConfluencePage[] {
  const links = Array.isArray(raw) ? raw : [];

  return uniqueBy(
    links
      .filter(isConfluenceRemoteLink)
      .map((link): ConfluencePage | undefined => {
        if (!isRecord(link)) {
          return undefined;
        }

        const object = firstPresent(link, ["object"]);
        const url = firstString(link, ["object.url", "url"]);
        const title = firstString(link, ["object.title", "title"]) ?? url;
        const pageId = parseConfluencePageId(url);

        if (!title) {
          return undefined;
        }

        return {
          title,
          ...(pageId ? { id: pageId } : {}),
          ...(url ? { url } : {}),
          ...(isRecord(object) && firstString(object, ["summary"]) ? { body: firstString(object, ["summary"]) } : {}),
        };
      })
      .filter((page): page is ConfluencePage => Boolean(page)),
    (page) => page.url ?? page.id ?? page.title,
  );
}

function normalizeConfluenceContent(raw: unknown, fallbackUrl?: string): ConfluencePage {
  const title = firstString(raw, ["title"]) ?? "Untitled Confluence page";
  const body = unknownToText(firstPresent(raw, ["body.storage.value", "body.view.value", "body"]));
  const id = firstString(raw, ["id"]);
  const url =
    firstString(raw, ["_links.base"]) && firstString(raw, ["_links.webui"])
      ? `${firstString(raw, ["_links.base"])}${firstString(raw, ["_links.webui"])}`
      : fallbackUrl;

  return {
    title,
    ...(id ? { id } : {}),
    ...(firstString(raw, ["space.key", "space.name"]) ? { space: firstString(raw, ["space.key", "space.name"]) } : {}),
    ...(url ? { url } : {}),
    ...(toIsoString(firstPresent(raw, ["version.when"])) ? { updatedAt: toIsoString(firstPresent(raw, ["version.when"])) } : {}),
    ...(body ? { body } : {}),
  };
}

function mergeConfluencePage(base: ConfluencePage, details: ConfluencePage): ConfluencePage {
  return {
    ...base,
    ...details,
    title: details.title || base.title,
  };
}

function isConfluenceRemoteLink(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  const url = firstString(value, ["object.url", "url"]) ?? "";
  const appName = firstString(value, ["application.name", "application.type"]) ?? "";
  const relationship = firstString(value, ["relationship"]) ?? "";

  return /\/wiki\/|confluence/i.test(`${url} ${appName} ${relationship}`);
}

function parseConfluencePageId(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }

  return /[?&]pageId=(\d+)/.exec(url)?.[1] ?? /\/pages\/(\d+)/.exec(url)?.[1];
}

function normalizeGraphqlDevelopment(raw: unknown): Development {
  const instanceTypes = asRecordArray(firstPresent(raw, ["details.instanceTypes"]));
  const branches: Branch[] = [];
  const pullRequests: PullRequest[] = [];

  for (const instanceType of instanceTypes) {
    const provider = firstString(instanceType, ["name", "typeName", "type", "id"]);
    const repositories = asRecordArray(firstPresent(instanceType, ["repository"]));
    const singleRepository = repositories.length === 1 ? repositories[0] : undefined;

    for (const repository of repositories) {
      const repositoryName = firstString(repository, ["name"]);

      branches.push(
        ...asRecordArray(firstPresent(repository, ["branches"]))
          .map((branch) => normalizeGraphqlBranch(branch, repositoryName, provider))
          .filter((branch): branch is Branch => branch !== undefined),
      );
    }

    for (const pullRequest of asRecordArray(firstPresent(instanceType, ["danglingPullRequests"]))) {
      pullRequests.push(
        ...[
          normalizeGraphqlPullRequest(
            pullRequest,
            firstString(pullRequest, ["repositoryName"]) ?? firstString(singleRepository, ["name"]),
            provider,
          ),
        ].filter((candidate): candidate is PullRequest => candidate !== undefined),
      );
    }

    for (const repository of repositories) {
      const repositoryName = firstString(repository, ["name"]);
      pullRequests.push(
        ...asRecordArray(firstPresent(repository, ["pullRequests"]))
          .map((pullRequest) => normalizeGraphqlPullRequest(pullRequest, repositoryName, provider))
          .filter((pullRequest): pullRequest is PullRequest => pullRequest !== undefined),
      );
    }
  }

  return {
    branches: uniqueBy(branches, (branch) => branch.url ?? `${branch.repository ?? ""}:${branch.name}`),
    pullRequests: uniqueBy(pullRequests, (pullRequest) => pullRequest.url ?? `${pullRequest.repository ?? ""}:${pullRequest.title}`),
  };
}

function normalizeGraphqlBranch(record: unknown, repository: string | undefined, provider: string | undefined): Branch | undefined {
  if (!isRecord(record)) {
    return undefined;
  }

  const name = firstString(record, ["name", "branchName"]);
  if (!name) {
    return undefined;
  }

  return {
    name,
    ...(repository ? { repository } : {}),
    ...(provider ? { provider } : {}),
    ...(firstString(record, ["url", "branchUrl", "createPullRequestUrl"]) ? { url: firstString(record, ["url", "branchUrl", "createPullRequestUrl"]) } : {}),
    ...(toIsoString(firstPresent(record, ["lastCommit.timestamp", "lastCommit.authorTimestamp", "lastUpdate", "lastUpdated"]))
      ? {
          lastUpdatedAt: toIsoString(
            firstPresent(record, ["lastCommit.timestamp", "lastCommit.authorTimestamp", "lastUpdate", "lastUpdated"]),
          ),
        }
      : {}),
  };
}

function normalizeGraphqlPullRequest(
  record: unknown,
  repository: string | undefined,
  provider: string | undefined,
): PullRequest | undefined {
  if (!isRecord(record)) {
    return undefined;
  }

  const title = firstString(record, ["name", "title", "summary"]) ?? firstString(record, ["url"]);
  if (!title) {
    return undefined;
  }

  return {
    title,
    ...(firstString(record, ["status", "state"]) ? { status: firstString(record, ["status", "state"]) } : {}),
    ...(firstString(record, ["url"]) ? { url: firstString(record, ["url"]) } : {}),
    ...(repository ? { repository } : {}),
    ...(provider ? { provider } : {}),
    ...(firstString(record, ["branchName", "sourceBranch", "source.branch"]) ? { sourceBranch: firstString(record, ["branchName", "sourceBranch", "source.branch"]) } : {}),
    ...(firstString(record, ["destinationBranchName", "targetBranch", "target.branch"])
      ? { targetBranch: firstString(record, ["destinationBranchName", "targetBranch", "target.branch"]) }
      : {}),
    ...(normalizeGraphqlPerson(firstPresent(record, ["author"])) ? { author: normalizeGraphqlPerson(firstPresent(record, ["author"])) } : {}),
    ...(toIsoString(firstPresent(record, ["lastUpdate", "lastUpdated", "updatedAt"]))
      ? { lastUpdatedAt: toIsoString(firstPresent(record, ["lastUpdate", "lastUpdated", "updatedAt"])) }
      : {}),
  };
}

function normalizeGraphqlPerson(value: unknown): Person | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const name = firstString(value, ["name", "displayName"]);
  const email = firstString(value, ["email", "emailAddress"]);
  const accountId = firstString(value, ["accountId", "id"]);

  if (!name && !email && !accountId) {
    return undefined;
  }

  return {
    ...(name ? { name } : {}),
    ...(email ? { email } : {}),
    ...(accountId ? { accountId } : {}),
  };
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  return asArray(value).filter(isRecord);
}

function buildIssueAri(cloudId: string, issueId: string): string {
  return `ari:cloud:jira:${cloudId}:issue/${issueId}`;
}

function buildDevelopmentInfoRequest(issueAri: string): unknown {
  return {
    operationName: "DevDetailsDialog",
    query: DEVELOPMENT_INFO_QUERY,
    variables: {
      issueId: issueAri,
    },
  };
}

function summarizeGraphqlErrors(errors: unknown[]): string {
  return errors
    .map((error) => (isRecord(error) ? (firstString(error, ["message"]) ?? JSON.stringify(error)) : String(error)))
    .join("; ")
    .slice(0, 1000);
}

const DEVELOPMENT_INFO_QUERY = `query DevDetailsDialog($issueId: ID!) {
  developmentInformation(issueId: $issueId) {
    details {
      instanceTypes {
        id
        name
        type
        typeName
        baseUrl
        repository {
          name
          url
          branches {
            name
            url
            createPullRequestUrl
            lastCommit {
              url
              displayId
              timestamp
            }
          }
          pullRequests {
            name
            url
            status
            lastUpdate
          }
        }
        danglingPullRequests {
          id
          url
          name
          branchName
          branchUrl
          lastUpdate
          status
          author {
            name
            avatarUrl
          }
          reviewers {
            name
            avatarUrl
            isApproved
          }
        }
      }
    }
  }
}`;

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (isRecord(error)) {
    return firstString(error, ["message", "error", "detail"]) ?? JSON.stringify(error);
  }

  return String(error);
}
