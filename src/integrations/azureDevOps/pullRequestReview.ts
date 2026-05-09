import type { ToolProvenance, Warning } from "../../domain/contextPack/schema.js";
import type { CodeReviewPullRequest } from "../../domain/codeReview/schema.js";
import { firstString } from "../../shared/utils.js";
import type { AzureDevOpsClient } from "./client.js";
import type { AzureDevOpsRepositoryRef } from "./pullRequestCreator.js";
import { azureDevOpsPullRequestWebUrl, resolveAzureDevOpsRepositoryFromEnvironment } from "./pullRequestCreator.js";

export interface AzureDevOpsPullRequestRef {
  repository: AzureDevOpsRepositoryRef;
  pullRequestId: number;
}

export class AzureDevOpsPullRequestReviewSource {
  private readonly provenance: ToolProvenance[] = [];
  private readonly warnings: Warning[] = [];

  constructor(private readonly client: AzureDevOpsClient) {}

  async getPullRequest(ref: AzureDevOpsPullRequestRef): Promise<CodeReviewPullRequest> {
    const payload = await this.callAzureDevOps("getPullRequest", "azure-devops:pull-request", () =>
      this.client.getJson(apiUrl(ref.repository, `pullrequests/${ref.pullRequestId}`)),
    );

    return normalizePullRequest(payload, ref);
  }

  getProvenance(): ToolProvenance[] {
    return [...this.provenance];
  }

  getWarnings(): Warning[] {
    return [...this.warnings];
  }

  private async callAzureDevOps(method: string, toolName: string, action: () => Promise<unknown>): Promise<unknown> {
    const calledAt = new Date().toISOString();

    try {
      const result = await action();
      this.provenance.push({ method, toolName, calledAt, success: true });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.provenance.push({ method, toolName, calledAt, success: false, message });
      throw error;
    }
  }
}

export class AzureDevOpsPullRequestCommentSink {
  private readonly provenance: ToolProvenance[] = [];
  private readonly warnings: Warning[] = [];

  constructor(private readonly client: AzureDevOpsClient) {}

  async createThread(ref: AzureDevOpsPullRequestRef, markdown: string): Promise<void> {
    await this.callAzureDevOps("createPullRequestThread", "azure-devops:pull-request-thread", () =>
      this.client.postJson(apiUrl(ref.repository, `pullRequests/${ref.pullRequestId}/threads`), {
        comments: [
          {
            parentCommentId: 0,
            content: markdown,
            commentType: 1,
          },
        ],
        status: "active",
      }),
    );
  }

  getProvenance(): ToolProvenance[] {
    return [...this.provenance];
  }

  getWarnings(): Warning[] {
    return [...this.warnings];
  }

  private async callAzureDevOps(method: string, toolName: string, action: () => Promise<unknown>): Promise<void> {
    const calledAt = new Date().toISOString();

    try {
      await action();
      this.provenance.push({ method, toolName, calledAt, success: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.provenance.push({ method, toolName, calledAt, success: false, message });
      throw error;
    }
  }
}

export function resolveAzureDevOpsPullRequestRefFromEnvironment(env: NodeJS.ProcessEnv = process.env): AzureDevOpsPullRequestRef | undefined {
  const repository = resolveAzureDevOpsRepositoryFromEnvironment(env);
  const pullRequestId = parsePullRequestId(env.SYSTEM_PULLREQUEST_PULLREQUESTID ?? env.SYSTEM_PULLREQUEST_PULLREQUESTNUMBER);

  return repository && pullRequestId ? { repository, pullRequestId } : undefined;
}

export function pullRequestToContextPullRequest(pullRequest: CodeReviewPullRequest) {
  return {
    title: pullRequest.title,
    url: pullRequest.url,
    provider: "azure-devops",
    ...(pullRequest.repository ? { repository: pullRequest.repository } : {}),
    ...(pullRequest.sourceBranch ? { sourceBranch: pullRequest.sourceBranch } : {}),
    ...(pullRequest.targetBranch ? { targetBranch: pullRequest.targetBranch } : {}),
  };
}

function normalizePullRequest(payload: unknown, ref: AzureDevOpsPullRequestRef): CodeReviewPullRequest {
  const title = firstString(payload, ["title"]) ?? `Pull request ${ref.pullRequestId}`;
  const description = firstString(payload, ["description"]);
  const repositoryName =
    firstString(payload, ["repository.name"]) ?? firstString(payload, ["repository.id"]) ?? ref.repository.repository;

  return {
    id: ref.pullRequestId,
    title,
    ...(description ? { description } : {}),
    ...(firstString(payload, ["sourceRefName"]) ? { sourceBranch: stripRef(firstString(payload, ["sourceRefName"]) ?? "") } : {}),
    ...(firstString(payload, ["targetRefName"]) ? { targetBranch: stripRef(firstString(payload, ["targetRefName"]) ?? "") } : {}),
    repository: repositoryName,
    project: ref.repository.project,
    organization: ref.repository.organization,
    url: azureDevOpsPullRequestWebUrl(ref.repository, ref.pullRequestId),
  };
}

function apiUrl(repository: AzureDevOpsRepositoryRef, suffix: string): URL {
  const pathSegments = [
    repository.organization,
    repository.project,
    "_apis",
    "git",
    "repositories",
    repository.repository,
    ...suffix.split("/").filter(Boolean),
  ];
  const url = new URL(`https://dev.azure.com/${pathSegments.map(encodeURIComponent).join("/")}`);
  url.searchParams.set("api-version", "7.1");
  return url;
}

function parsePullRequestId(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function stripRef(value: string): string {
  return value.replace(/^refs\/heads\//, "");
}
