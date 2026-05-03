import type { AzureDevOpsClient } from "./client.js";

export interface AzureDevOpsRepositoryRef {
  organization: string;
  project: string;
  repository: string;
}

export interface CreateAzureDevOpsPullRequestInput {
  repository: AzureDevOpsRepositoryRef;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description: string;
}

export interface CreatedAzureDevOpsPullRequest {
  id: number;
  url: string;
}

export class AzureDevOpsPullRequestCreator {
  constructor(private readonly client: AzureDevOpsClient) {}

  async create(input: CreateAzureDevOpsPullRequestInput): Promise<CreatedAzureDevOpsPullRequest> {
    const url = azureDevOpsApiUrl(input.repository, `_apis/git/repositories/${input.repository.repository}/pullrequests`);
    url.searchParams.set("api-version", "7.1");

    const payload = await this.client.postJson(url, {
      sourceRefName: toRefName(input.sourceBranch),
      targetRefName: toRefName(input.targetBranch),
      title: input.title,
      description: input.description,
    });

    const id = readPullRequestId(payload);
    return {
      id,
      url: azureDevOpsPullRequestWebUrl(input.repository, id),
    };
  }
}

export function resolveAzureDevOpsRepository(remoteUrl: string | undefined, env: NodeJS.ProcessEnv = process.env): AzureDevOpsRepositoryRef | undefined {
  const fromEnvironment = resolveAzureDevOpsRepositoryFromEnvironment(env);
  if (fromEnvironment) {
    return fromEnvironment;
  }

  if (!remoteUrl) {
    return undefined;
  }

  return resolveAzureDevOpsRepositoryFromRemote(remoteUrl);
}

export function resolveAzureDevOpsRepositoryFromEnvironment(env: NodeJS.ProcessEnv): AzureDevOpsRepositoryRef | undefined {
  const collectionUri = env.SYSTEM_COLLECTIONURI;
  const project = env.SYSTEM_TEAMPROJECT;
  const repository = env.BUILD_REPOSITORY_ID ?? env.BUILD_REPOSITORY_NAME;
  if (!collectionUri || !project || !repository) {
    return undefined;
  }

  const organization = organizationFromCollectionUri(collectionUri);
  return organization ? { organization, project, repository } : undefined;
}

export function resolveAzureDevOpsRepositoryFromRemote(remoteUrl: string): AzureDevOpsRepositoryRef | undefined {
  const normalized = remoteUrl.trim().replace(/\.git$/i, "");
  const sshMatch = normalized.match(/^(?:git@ssh\.dev\.azure\.com:v3\/|ssh:\/\/git@ssh\.dev\.azure\.com\/v3\/)([^/]+)\/([^/]+)\/(.+)$/i);
  if (sshMatch) {
    const [, organization, project, repository] = sshMatch;
    return organization && project && repository
      ? {
          organization: decodeURIComponent(organization),
          project: decodeURIComponent(project),
          repository: decodeURIComponent(repository),
        }
      : undefined;
  }

  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    return undefined;
  }

  const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (url.hostname.toLowerCase() === "dev.azure.com") {
    const [organization, project, marker, repository] = segments;
    return organization && project && marker?.toLowerCase() === "_git" && repository
      ? { organization, project, repository }
      : undefined;
  }

  const visualStudioMatch = url.hostname.match(/^([^.]+)\.visualstudio\.com$/i);
  if (visualStudioMatch) {
    const [, organization] = visualStudioMatch;
    const [project, marker, repository] = segments;
    return organization && project && marker?.toLowerCase() === "_git" && repository
      ? { organization, project, repository }
      : undefined;
  }

  return undefined;
}

export function azureDevOpsPullRequestWebUrl(repository: AzureDevOpsRepositoryRef, pullRequestId: number): string {
  return `https://dev.azure.com/${encodePathSegment(repository.organization)}/${encodePathSegment(repository.project)}/_git/${encodePathSegment(repository.repository)}/pullrequest/${pullRequestId}`;
}

function azureDevOpsApiUrl(repository: AzureDevOpsRepositoryRef, relativePath: string): URL {
  return new URL(
    `${encodePathSegment(repository.project)}/${relativePath}`,
    `https://dev.azure.com/${encodePathSegment(repository.organization)}/`,
  );
}

function toRefName(branch: string): string {
  return branch.startsWith("refs/heads/") ? branch : `refs/heads/${branch}`;
}

function readPullRequestId(payload: unknown): number {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Azure DevOps create pull request response was not an object.");
  }

  const value = (payload as Record<string, unknown>).pullRequestId;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error("Azure DevOps create pull request response did not include pullRequestId.");
  }

  return value;
}

function organizationFromCollectionUri(collectionUri: string): string | undefined {
  let url: URL;
  try {
    url = new URL(collectionUri);
  } catch {
    return undefined;
  }

  if (url.hostname.toLowerCase() === "dev.azure.com") {
    const [organization] = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    return organization;
  }

  const visualStudioMatch = url.hostname.match(/^([^.]+)\.visualstudio\.com$/i);
  return visualStudioMatch?.[1];
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value).replace(/%2F/gi, "/");
}
