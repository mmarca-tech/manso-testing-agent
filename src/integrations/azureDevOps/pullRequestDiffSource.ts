import type { PullRequest, ToolProvenance, Warning } from "../../domain/contextPack/schema.js";
import type { PullRequestCommit, PullRequestDiff, PullRequestFileChange, PullRequestSourceFile } from "../../domain/prChanges/schema.js";
import { asArray, firstPresent, firstString, isRecord, toIsoString, uniqueBy } from "../../shared/utils.js";
import type { PrDiffSource } from "../../workflows/pr-changes/prDiffSource.js";
import type { AzureDevOpsClient } from "./client.js";

interface AzureDevOpsPullRequestRef {
  organization: string;
  project: string;
  repository: string;
  pullRequestId: string;
}

export class AzureDevOpsPullRequestDiffSource implements PrDiffSource {
  private readonly client: AzureDevOpsClient;
  private readonly maxChangedSourceFiles: number;
  private readonly maxSourceFileChars: number;
  private readonly provenance: ToolProvenance[] = [];
  private readonly warnings: Warning[] = [];

  constructor(client: AzureDevOpsClient, options: { maxChangedSourceFiles?: number; maxSourceFileChars?: number } = {}) {
    this.client = client;
    this.maxChangedSourceFiles = options.maxChangedSourceFiles ?? 10;
    this.maxSourceFileChars = options.maxSourceFileChars ?? 50_000;
  }

  async getPullRequestDiff(pullRequest: PullRequest): Promise<PullRequestDiff> {
    const ref = parseAzureDevOpsPullRequestUrl(pullRequest.url);
    if (!ref) {
      this.warnings.push({
        section: "pullRequests",
        message: `Unsupported pull request URL: ${pullRequest.url ?? pullRequest.title}`,
      });
      return { provider: pullRequest.provider ?? "unsupported", files: [], sourceFiles: [], commits: [], changeCounts: {} };
    }

    const details = await this.callAzureDevOps("getPullRequest", "azure-devops:pull-request", () =>
      this.client.getJson(apiUrl(ref, `pullrequests/${ref.pullRequestId}`, { includeCommits: true })),
    );
    const commitsPayload = await this.callAzureDevOps("getPullRequestCommits", "azure-devops:pull-request-commits", () =>
      this.client.getJson(apiUrl(ref, `pullRequests/${ref.pullRequestId}/commits`, { "$top": 250 })),
    );
    const iterationsPayload = await this.callAzureDevOps("getPullRequestIterations", "azure-devops:pull-request-iterations", () =>
      this.client.getJson(apiUrl(ref, `pullRequests/${ref.pullRequestId}/iterations`, { includeCommits: true })),
    );

    const latestIteration = latestIterationId(iterationsPayload);
    const changesPayload =
      latestIteration === undefined
        ? undefined
        : await this.callAzureDevOps("getPullRequestChanges", "azure-devops:pull-request-iteration-changes", () =>
            this.client.getJson(apiUrl(ref, `pullRequests/${ref.pullRequestId}/iterations/${latestIteration}/changes`, { "$top": 500 })),
          );

    const files = normalizeFileChanges(changesPayload ?? firstPresent(iterationsPayload, ["value"]));
    const commits = normalizeCommits(commitsPayload);
    const sourceFiles = await this.getSourceFiles(ref, details, files);

    return {
      provider: "azure-devops",
      files,
      sourceFiles,
      commits,
      changeCounts: normalizeChangeCounts(changesPayload, files),
      ...(typeof firstPresent(changesPayload, ["allChangesIncluded"]) === "boolean"
        ? { allChangesIncluded: firstPresent(changesPayload, ["allChangesIncluded"]) as boolean }
        : {}),
    };
  }

  private async getSourceFiles(
    ref: AzureDevOpsPullRequestRef,
    details: unknown,
    files: PullRequestFileChange[],
  ): Promise<PullRequestSourceFile[]> {
    const headCommit = firstString(details, ["lastMergeSourceCommit.commitId", "lastMergeCommit.commitId"]);
    const changedSourceFiles = files
      .filter((file) => isSourceFilePath(file.path) && !isExcludedSourcePath(file.path) && !file.isFolder && !isDeleteChange(file.changeType))
      .slice(0, this.maxChangedSourceFiles);

    const output: PullRequestSourceFile[] = [];
    for (const file of changedSourceFiles) {
      const fetched = await this.tryGetSourceFile(ref, file.path, headCommit, {
        role: "changed",
        changeType: file.changeType,
        reason: "Changed in the pull request.",
      });
      if (fetched) {
        output.push(fetched);
      }
    }

    return uniqueBy(output, (file) => file.path);
  }

  private async tryGetSourceFile(
    ref: AzureDevOpsPullRequestRef,
    path: string,
    version: string | undefined,
    metadata: { role: PullRequestSourceFile["role"]; changeType?: string; reason?: string },
  ): Promise<PullRequestSourceFile | undefined> {
    try {
      const content = await this.callAzureDevOps("getPullRequestSourceFile", "azure-devops:source-file", () =>
        this.client.getText(
          apiUrl(ref, "items", {
            path,
            ...(version ? { version, versionType: "commit" } : {}),
          }),
        ),
      );
      const text = typeof content === "string" ? content : String(content);
      const truncated = text.length > this.maxSourceFileChars;

      return {
        path,
        role: metadata.role,
        ...(metadata.changeType ? { changeType: metadata.changeType } : {}),
        ...(languageFromPath(path) ? { language: languageFromPath(path) } : {}),
        content: truncated ? `${text.slice(0, this.maxSourceFileChars)}\n[... truncated: file exceeded ${this.maxSourceFileChars} characters ...]` : text,
        truncated,
        ...(metadata.reason ? { reason: metadata.reason } : {}),
      };
    } catch (error) {
      this.warnings.push({
        section: "pullRequests",
        toolName: "azure-devops:source-file",
        message: `Could not fetch source file ${path}: ${error instanceof Error ? error.message : String(error)}`,
      });
      return undefined;
    }
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

function parseAzureDevOpsPullRequestUrl(value: string | undefined): AzureDevOpsPullRequestRef | undefined {
  if (!value) {
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }

  if (url.hostname.toLowerCase() !== "dev.azure.com") {
    return undefined;
  }

  const segments = url.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));
  const gitIndex = segments.findIndex((segment) => segment.toLowerCase() === "_git");
  const prIndex = segments.findIndex((segment) => segment.toLowerCase() === "pullrequest");

  const organization = segments[0];
  const repository = segments[gitIndex + 1];
  const pullRequestId = segments[prIndex + 1];

  if (gitIndex < 1 || prIndex < gitIndex + 2 || !organization || !repository || !pullRequestId) {
    return undefined;
  }

  return {
    organization,
    project: segments.slice(1, gitIndex).join("/"),
    repository,
    pullRequestId,
  };
}

function apiUrl(ref: AzureDevOpsPullRequestRef, suffix: string, query: Record<string, string | number | boolean> = {}): URL {
  const pathSegments = [
    ref.organization,
    ...ref.project.split("/").filter(Boolean),
    "_apis",
    "git",
    "repositories",
    ref.repository,
    ...suffix.split("/").filter(Boolean),
  ];
  const url = new URL(`https://dev.azure.com/${pathSegments.map(encodeURIComponent).join("/")}`);
  url.searchParams.set("api-version", "7.1");

  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, String(value));
  }

  return url;
}

function latestIterationId(value: unknown): number | undefined {
  const iterations = asRecordArray(firstPresent(value, ["value", "iterations", "results", "changeEntries", "changes"]));
  const ids = iterations
    .map((iteration) => Number(firstPresent(iteration, ["id", "iterationId"])))
    .filter((id) => Number.isInteger(id));

  return ids.length > 0 ? Math.max(...ids) : undefined;
}

function normalizeFileChanges(raw: unknown): PullRequestFileChange[] {
  const changes = collectChangeRecords(raw);

  return uniqueBy(
    changes
      .map((change): PullRequestFileChange | undefined => {
        const path = firstString(change, ["item.path", "path", "targetItem.path", "sourceServerItem"]);
        const changeType = firstString(change, ["changeType", "item.changeType"]) ?? "unknown";

        if (!path) {
          return undefined;
        }

        return {
          path,
          changeType,
          ...(firstString(change, ["originalPath"]) ? { originalPath: firstString(change, ["originalPath"]) } : {}),
          ...(typeof firstPresent(change, ["item.isFolder", "isFolder"]) === "boolean"
            ? { isFolder: firstPresent(change, ["item.isFolder", "isFolder"]) as boolean }
            : {}),
          ...(firstString(change, ["item.url", "url"]) ? { url: firstString(change, ["item.url", "url"]) } : {}),
        };
      })
      .filter((file): file is PullRequestFileChange => file !== undefined),
    (file) => file.path,
  );
}

function collectChangeRecords(raw: unknown): Record<string, unknown>[] {
  const direct = [
    ...asRecordArray(firstPresent(raw, ["changeEntries"])),
    ...asRecordArray(firstPresent(raw, ["changes"])),
    ...asRecordArray(firstPresent(raw, ["value"])),
    ...asRecordArray(firstPresent(raw, ["changeList"])),
    ...asRecordArray(Array.isArray(raw) ? raw : undefined),
  ];

  if (direct.length > 0) {
    return direct.flatMap((record) => {
      const nested = asRecordArray(firstPresent(record, ["changeList", "changes", "changeEntries"]));
      return nested.length > 0 ? nested : [record];
    });
  }

  return [];
}

function normalizeCommits(raw: unknown): PullRequestCommit[] {
  const commits = asRecordArray(firstPresent(raw, ["value", "commits", "results", "changes"]));

  return uniqueBy(
    commits
      .map((commit): PullRequestCommit | undefined => {
        const id = firstString(commit, ["commitId", "id", "sha"]);
        if (!id) {
          return undefined;
        }

        return {
          id,
          ...(firstString(commit, ["comment", "message"]) ? { comment: firstString(commit, ["comment", "message"]) } : {}),
          ...(normalizePerson(firstPresent(commit, ["author", "committer"])) ? { author: normalizePerson(firstPresent(commit, ["author", "committer"])) } : {}),
          ...(toIsoString(firstPresent(commit, ["author.date", "committer.date", "date"])) ? { authoredAt: toIsoString(firstPresent(commit, ["author.date", "committer.date", "date"])) } : {}),
          ...(firstString(commit, ["remoteUrl", "url"]) ? { url: firstString(commit, ["remoteUrl", "url"]) } : {}),
        };
      })
      .filter((commit): commit is PullRequestCommit => commit !== undefined),
    (commit) => commit.id,
  );
}

function normalizeChangeCounts(raw: unknown, files: PullRequestFileChange[]): Record<string, number> {
  const counts = firstPresent(raw, ["changeCounts"]);
  if (isRecord(counts)) {
    return Object.fromEntries(
      Object.entries(counts)
        .map(([key, value]) => [key, Number(value)] as const)
        .filter(([, value]) => Number.isFinite(value)),
    );
  }

  return files.reduce<Record<string, number>>((accumulator, file) => {
    accumulator[file.changeType] = (accumulator[file.changeType] ?? 0) + 1;
    return accumulator;
  }, {});
}

function normalizePerson(value: unknown): PullRequestCommit["author"] {
  if (!isRecord(value)) {
    return undefined;
  }

  const name = firstString(value, ["displayName", "name"]);
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

function isSourceFilePath(path: string): boolean {
  const lower = path.toLowerCase();
  return SOURCE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

function isExcludedSourcePath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  return EXCLUDED_SOURCE_PATTERNS.some((pattern) => normalized.includes(pattern));
}

function isDeleteChange(changeType: string): boolean {
  return /delete|remove/i.test(changeType);
}

function languageFromPath(path: string): string | undefined {
  const lower = path.toLowerCase();
  const match = SOURCE_EXTENSIONS.find((extension) => lower.endsWith(extension));
  if (!match) {
    return undefined;
  }

  return LANGUAGE_BY_EXTENSION[match] ?? match.replace(/^\./, "");
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  return asArray(value).filter(isRecord);
}

const SOURCE_EXTENSIONS = [".cs", ".ts", ".tsx", ".js", ".jsx", ".py", ".java", ".kt", ".go", ".sql", ".json", ".yml", ".yaml", ".xml"];

const EXCLUDED_SOURCE_PATTERNS = [
  "/node_modules/",
  "/dist/",
  "/build/",
  "/bin/",
  "/obj/",
  "/coverage/",
  ".min.js",
  ".generated.",
  ".designer.cs",
  "assemblyinfo.cs",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
];

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".cs": "csharp",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".py": "python",
  ".java": "java",
  ".kt": "kotlin",
  ".go": "go",
  ".sql": "sql",
  ".json": "json",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".xml": "xml",
};
