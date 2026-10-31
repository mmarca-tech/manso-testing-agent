import type {
  Attachment,
  Branch,
  Comment,
  ConfluencePage,
  Development,
  FixVersion,
  Person,
  PullRequest,
  Ticket,
  TicketLink,
} from "../../domain/contextPack/schema.js";
import type { NormalizedIssue } from "../../domain/tickets/normalizedIssue.js";
import {
  asArray,
  buildUrl,
  collectObjects,
  compactStrings,
  detectTextFormat,
  firstPresent,
  firstString,
  getPath,
  isNonEmptyString,
  isRecord,
  toIsoString,
  toStringArray,
  uniqueBy,
  unknownToText,
} from "../../shared/utils.js";

export function normalizeIssue(raw: unknown, requestedKey: string): NormalizedIssue {
  const issue = findIssueRecord(raw, requestedKey);
  const fields = isRecord(issue.fields) ? issue.fields : {};
  const key = firstString(issue, ["key", "issueKey", "displayId"]) ?? requestedKey;
  const title = firstString(issue, ["fields.summary", "summary", "title", "name", "fields.title"]) ?? key;
  const descriptionRaw = firstPresent(issue, ["fields.description", "description", "body", "fields.body"]);
  const url = normalizeUrl(issue);
  const statusCategory = firstString(issue, ["fields.status.statusCategory.key", "status.statusCategory.key"]);
  const resolution = firstString(issue, ["fields.resolution.name", "resolution.name"]);
  const fixVersions = normalizeFixVersions(firstPresent(issue, ["fields.fixVersions", "fixVersions"]));
  const affectedServices = normalizeAffectedServices(raw, issue, fields);
  const completedAt = normalizeCompletedAt(raw, issue, fields);

  const ticket: Ticket = {
    key,
    title,
    labels: toStringArray(firstPresent(issue, ["fields.labels", "labels"])),
    components: toStringArray(firstPresent(issue, ["fields.components", "components"])),
    links: normalizeLinkedIssues(issue, key),
    ...(optionalString(firstString(issue, ["fields.issuetype.name", "issuetype.name", "issueType.name", "issueType", "type"])) ??
    false
      ? {
          issueType: firstString(issue, [
            "fields.issuetype.name",
            "issuetype.name",
            "issueType.name",
            "issueType",
            "type",
          ]),
        }
      : {}),
    ...(optionalString(firstString(issue, ["fields.status.name", "status.name", "status", "state"])) ?? false
      ? { status: firstString(issue, ["fields.status.name", "status.name", "status", "state"]) }
      : {}),
    ...(statusCategory ? { statusCategory } : {}),
    ...(resolution ? { resolution } : {}),
    ...(fixVersions.length > 0 ? { fixVersions } : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(affectedServices.length > 0 ? { affectedServices } : {}),
    ...(normalizePerson(firstPresent(issue, ["fields.assignee", "assignee"]))
      ? { assignee: normalizePerson(firstPresent(issue, ["fields.assignee", "assignee"])) }
      : {}),
    ...(normalizePerson(firstPresent(issue, ["fields.reporter", "reporter"]))
      ? { reporter: normalizePerson(firstPresent(issue, ["fields.reporter", "reporter"])) }
      : {}),
    ...(url ? { url } : {}),
  };

  return {
    ticket,
    description: {
      format: detectTextFormat(descriptionRaw),
      text: unknownToText(descriptionRaw),
    },
    comments: normalizeComments(firstPresent(issue, ["fields.comment.comments", "comment.comments", "comments"]), url),
    linkedIssues: ticket.links,
  };
}

export function normalizeComments(raw: unknown, issueUrl?: string): Comment[] {
  const directCandidates = compactCandidates([
    firstPresent(raw, ["comments"]),
    firstPresent(raw, ["values"]),
    firstPresent(raw, ["results"]),
    firstPresent(raw, ["data.comments"]),
    Array.isArray(raw) ? raw : undefined,
  ]);

  const candidates =
    directCandidates.length > 0
      ? directCandidates.flatMap(asArray)
      : collectObjects(raw, (record) => {
          const body = firstPresent(record, ["body", "comment", "text", "renderedBody"]);
          return body !== undefined && firstPresent(record, ["author", "created", "createdAt", "updated"]) !== undefined;
        });

  return uniqueBy(
    candidates
      .map((candidate) => normalizeComment(candidate, issueUrl))
      .filter((comment): comment is Comment => comment !== undefined),
    (comment) => comment.id ?? comment.url ?? `${comment.createdAt ?? ""}:${comment.body.slice(0, 80)}`,
  );
}

export function normalizeAttachments(raw: unknown): Attachment[] {
  const directCandidates = compactCandidates([
    firstPresent(raw, ["fields.attachment"]),
    firstPresent(raw, ["attachment"]),
    firstPresent(raw, ["attachments"]),
    firstPresent(raw, ["values"]),
    firstPresent(raw, ["results"]),
    Array.isArray(raw) ? raw : undefined,
  ]).flatMap(asArray);

  const candidates =
    directCandidates.length > 0
      ? directCandidates
      : collectObjects(raw, (record) => {
          return Boolean(firstString(record, ["filename", "name"]) && firstPresent(record, ["content", "url", "self"]) !== undefined);
        });

  return uniqueBy(
    candidates
      .map(normalizeAttachment)
      .filter((attachment): attachment is Attachment => attachment !== undefined),
    (attachment) => attachment.id ?? attachment.url ?? attachment.filename,
  );
}

export function normalizeLinkedIssues(raw: unknown, currentIssueKey?: string): TicketLink[] {
  const parentLinks = normalizeParentLink(raw, currentIssueKey);
  const subtaskLinks = normalizeSubtaskLinks(raw, currentIssueKey);

  const linkContainers = compactCandidates([
    firstPresent(raw, ["fields.issuelinks"]),
    firstPresent(raw, ["issuelinks"]),
    firstPresent(raw, ["issueLinks"]),
    firstPresent(raw, ["linkedIssues"]),
    firstPresent(raw, ["links"]),
    Array.isArray(raw) ? raw : undefined,
  ]).flatMap(asArray);

  const linksFromIssueLinks = linkContainers.flatMap((link) => normalizeIssueLinkContainer(link, currentIssueKey));

  const linksFromObjects =
    linksFromIssueLinks.length > 0 || parentLinks.length > 0 || subtaskLinks.length > 0
      ? []
      : collectObjects(raw, (record) => {
          const key = firstString(record, ["key", "issueKey", "displayId", "fields.key"]);
          return Boolean(key && key !== currentIssueKey && looksLikeJiraKey(key));
        }).map((record) => normalizeIssueRecordAsLink(record, "unknown"));

  // Parent/subtasks first so their labelled relationship wins de-duplication.
  return uniqueBy(
    [...parentLinks, ...subtaskLinks, ...linksFromIssueLinks, ...linksFromObjects],
    (link) => link.issueKey ?? link.url,
  );
}

function normalizeParentLink(raw: unknown, currentIssueKey?: string): TicketLink[] {
  const parent = firstPresent(raw, ["fields.parent", "parent"]);
  if (!isRecord(parent)) {
    return [];
  }
  const relationship = /epic/i.test(firstString(parent, ["fields.issuetype.name", "issuetype.name", "issueType"]) ?? "")
    ? "epic"
    : "parent";
  const link = normalizeIssueRecordAsLink(parent, "outward", relationship);
  if (!link.issueKey || link.issueKey === currentIssueKey || !looksLikeJiraKey(link.issueKey)) {
    return [];
  }
  return [link];
}

function normalizeSubtaskLinks(raw: unknown, currentIssueKey?: string): TicketLink[] {
  return asArray(firstPresent(raw, ["fields.subtasks", "subtasks"]))
    .filter(isRecord)
    .map((subtask) => normalizeIssueRecordAsLink(subtask, "inward", "subtask"))
    .filter((link) => Boolean(link.issueKey) && link.issueKey !== currentIssueKey && looksLikeJiraKey(link.issueKey ?? ""));
}

export function normalizeDevelopment(raw: unknown): Development {
  const branchCandidates = collectNamedArrays(raw, ["branches", "branch"])
    .flatMap(asArray)
    .filter(isRecordLikeBranch);

  const pullRequestCandidates = collectNamedArrays(raw, ["pullRequests", "pullrequests", "prs", "mergeRequests", "reviews"])
    .flatMap(asArray)
    .filter(isRecordLikePullRequest);

  const branches = uniqueBy(
    branchCandidates
      .map(normalizeBranch)
      .filter((branch): branch is Branch => branch !== undefined),
    (branch) => branch.url ?? `${branch.repository ?? ""}:${branch.name}`,
  );

  const pullRequests = uniqueBy(
    pullRequestCandidates
      .map(normalizePullRequest)
      .filter((pullRequest): pullRequest is PullRequest => pullRequest !== undefined),
    (pullRequest) => pullRequest.url ?? `${pullRequest.repository ?? ""}:${pullRequest.title}`,
  );

  return { branches, pullRequests };
}

export function normalizeConfluencePages(raw: unknown): ConfluencePage[] {
  const directCandidates = compactCandidates([
    firstPresent(raw, ["pages"]),
    firstPresent(raw, ["confluencePages"]),
    firstPresent(raw, ["results"]),
    firstPresent(raw, ["values"]),
    firstPresent(raw, ["objects"]),
    Array.isArray(raw) ? raw : undefined,
  ]).flatMap(asArray);

  const candidates =
    directCandidates.length > 0
      ? directCandidates
      : isRecord(raw) && firstString(raw, ["title", "name"])
        ? [raw]
        : collectObjects(raw, (record) => {
            const type = firstString(record, ["objectType", "type", "contentType"]);
            return Boolean(
              firstString(record, ["title", "name"]) &&
                (/confluence|page/i.test(type ?? "") ||
                  firstPresent(record, ["body", "space", "spaceKey", "_links.webui"]) !== undefined),
            );
          });

  return uniqueBy(
    candidates
      .map(normalizeConfluencePage)
      .filter((page): page is ConfluencePage => page !== undefined),
    (page) => page.url ?? page.id ?? page.title,
  );
}

function normalizeComment(candidate: unknown, issueUrl?: string): Comment | undefined {
  if (!isRecord(candidate)) {
    return undefined;
  }

  const body = unknownToText(firstPresent(candidate, ["body", "comment", "text", "renderedBody", "content"]));
  if (!body) {
    return undefined;
  }

  const id = firstString(candidate, ["id", "commentId"]);
  const url = normalizeUrl(candidate) ?? (issueUrl && id ? `${issueUrl}?focusedCommentId=${encodeURIComponent(id)}` : undefined);

  return {
    body,
    ...(id ? { id } : {}),
    ...(normalizePerson(firstPresent(candidate, ["author", "createdBy", "user"])) ??
    false
      ? { author: normalizePerson(firstPresent(candidate, ["author", "createdBy", "user"])) }
      : {}),
    ...(toIsoString(firstPresent(candidate, ["created", "createdAt", "createdDate"])) ??
    false
      ? { createdAt: toIsoString(firstPresent(candidate, ["created", "createdAt", "createdDate"])) }
      : {}),
    ...(toIsoString(firstPresent(candidate, ["updated", "updatedAt", "updatedDate"])) ??
    false
      ? { updatedAt: toIsoString(firstPresent(candidate, ["updated", "updatedAt", "updatedDate"])) }
      : {}),
    ...(firstString(candidate, ["visibility.value", "visibility.type", "visibility"]) ?? false
      ? { visibility: firstString(candidate, ["visibility.value", "visibility.type", "visibility"]) }
      : {}),
    ...(url ? { url } : {}),
  };
}

function normalizeAttachment(candidate: unknown): Attachment | undefined {
  if (!isRecord(candidate)) {
    return undefined;
  }

  const filename = firstString(candidate, ["filename", "name", "title"]);
  if (!filename) {
    return undefined;
  }

  const size = firstPresent(candidate, ["size", "sizeBytes"]);
  const sizeBytes = typeof size === "number" && Number.isFinite(size) && size >= 0 ? Math.trunc(size) : undefined;
  const url = firstString(candidate, ["content", "url", "self", "href"]);

  return {
    filename,
    ...(firstString(candidate, ["id", "attachmentId"]) ? { id: firstString(candidate, ["id", "attachmentId"]) } : {}),
    ...(firstString(candidate, ["mimeType", "mime_type", "mediaType", "contentType"]) ? { mimeType: firstString(candidate, ["mimeType", "mime_type", "mediaType", "contentType"]) } : {}),
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    ...(url ? { url } : {}),
  };
}

function normalizeIssueLinkContainer(link: unknown, currentIssueKey?: string): TicketLink[] {
  if (!isRecord(link)) {
    return [];
  }

  const output: TicketLink[] = [];

  if (isRecord(link.inwardIssue)) {
    output.push(
      normalizeIssueRecordAsLink(
        link.inwardIssue,
        "inward",
        firstString(link, ["type.inward", "type.name", "relationship"]),
      ),
    );
  }

  if (isRecord(link.outwardIssue)) {
    output.push(
      normalizeIssueRecordAsLink(
        link.outwardIssue,
        "outward",
        firstString(link, ["type.outward", "type.name", "relationship"]),
      ),
    );
  }

  if (output.length > 0) {
    return output.filter((item) => item.issueKey !== currentIssueKey);
  }

  const issueKey = firstString(link, ["issueKey", "key", "target.key", "target.issueKey", "object.key"]);
  if (!issueKey || issueKey === currentIssueKey || !looksLikeJiraKey(issueKey)) {
    return [];
  }

  return [normalizeIssueRecordAsLink(link, "unknown", firstString(link, ["relationship", "type.name", "linkType"]))];
}

function normalizeIssueRecordAsLink(record: UnknownIssueRecord, direction: TicketLink["direction"], relationship?: string): TicketLink {
  const url = normalizeUrl(record);
  return {
    direction,
    ...(relationship ? { relationship } : {}),
    ...(firstString(record, ["key", "issueKey", "displayId", "fields.key"]) ??
    false
      ? { issueKey: firstString(record, ["key", "issueKey", "displayId", "fields.key"]) }
      : {}),
    ...(firstString(record, ["fields.summary", "summary", "title", "name"]) ??
    false
      ? { title: firstString(record, ["fields.summary", "summary", "title", "name"]) }
      : {}),
    ...(firstString(record, ["fields.status.name", "status.name", "status", "state"]) ??
    false
      ? { status: firstString(record, ["fields.status.name", "status.name", "status", "state"]) }
      : {}),
    ...(firstString(record, ["fields.issuetype.name", "issuetype.name", "issueType.name", "issueType", "type"]) ??
    false
      ? {
          issueType: firstString(record, [
            "fields.issuetype.name",
            "issuetype.name",
            "issueType.name",
            "issueType",
            "type",
          ]),
        }
      : {}),
    ...(url ? { url } : {}),
  };
}

type UnknownIssueRecord = Record<string, unknown>;

function normalizeBranch(record: unknown): Branch | undefined {
  if (!isRecord(record)) {
    return undefined;
  }

  const name = firstString(record, ["name", "branchName", "displayId", "ref", "refName"]);
  if (!name) {
    return undefined;
  }

  return {
    name,
    ...(firstString(record, ["repository.name", "repositoryName", "repo.name", "repo", "repository"]) ??
    false
      ? { repository: firstString(record, ["repository.name", "repositoryName", "repo.name", "repo", "repository"]) }
      : {}),
    ...(firstString(record, ["provider", "providerName", "repository.provider"]) ??
    false
      ? { provider: firstString(record, ["provider", "providerName", "repository.provider"]) }
      : {}),
    ...(normalizeUrl(record) ? { url: normalizeUrl(record) } : {}),
    ...(toIsoString(firstPresent(record, ["lastUpdated", "lastUpdatedAt", "updated", "lastCommit.authorTimestamp"])) ??
    false
      ? {
          lastUpdatedAt: toIsoString(
            firstPresent(record, ["lastUpdated", "lastUpdatedAt", "updated", "lastCommit.authorTimestamp"]),
          ),
        }
      : {}),
  };
}

function normalizePullRequest(record: unknown): PullRequest | undefined {
  if (!isRecord(record)) {
    return undefined;
  }

  const title = firstString(record, ["title", "name", "summary"]);
  if (!title) {
    return undefined;
  }

  return {
    title,
    ...(firstString(record, ["status", "state", "reviewState"]) ?? false
      ? { status: firstString(record, ["status", "state", "reviewState"]) }
      : {}),
    ...(normalizeUrl(record) ? { url: normalizeUrl(record) } : {}),
    ...(firstString(record, ["repository.name", "repositoryName", "repo.name", "repo", "repository"]) ??
    false
      ? { repository: firstString(record, ["repository.name", "repositoryName", "repo.name", "repo", "repository"]) }
      : {}),
    ...(firstString(record, ["provider", "providerName", "repository.provider"]) ??
    false
      ? { provider: firstString(record, ["provider", "providerName", "repository.provider"]) }
      : {}),
    ...(firstString(record, ["source.branch", "sourceBranch", "source.name", "fromRef.displayId", "fromBranch"]) ??
    false
      ? {
          sourceBranch: firstString(record, [
            "source.branch",
            "sourceBranch",
            "source.name",
            "fromRef.displayId",
            "fromBranch",
          ]),
        }
      : {}),
    ...(firstString(record, [
      "destination.branch",
      "target.branch",
      "targetBranch",
      "toRef.displayId",
      "destinationBranch",
    ]) ?? false
      ? {
          targetBranch: firstString(record, [
            "destination.branch",
            "target.branch",
            "targetBranch",
            "toRef.displayId",
            "destinationBranch",
          ]),
        }
      : {}),
    ...(normalizePerson(firstPresent(record, ["author", "createdBy", "user"])) ??
    false
      ? { author: normalizePerson(firstPresent(record, ["author", "createdBy", "user"])) }
      : {}),
    ...(toIsoString(firstPresent(record, ["lastUpdate", "lastUpdated", "lastUpdatedAt", "updated", "updatedAt"])) ??
    false
      ? { lastUpdatedAt: toIsoString(firstPresent(record, ["lastUpdate", "lastUpdated", "lastUpdatedAt", "updated", "updatedAt"])) }
      : {}),
  };
}

function normalizeConfluencePage(record: unknown): ConfluencePage | undefined {
  if (!isRecord(record)) {
    return undefined;
  }

  const title = firstString(record, ["title", "name"]);
  if (!title) {
    return undefined;
  }

  const body = unknownToText(firstPresent(record, ["body", "content", "excerpt"]));
  const url = normalizeUrl(record);

  return {
    title,
    ...(firstString(record, ["id", "contentId", "pageId"]) ?? false
      ? { id: firstString(record, ["id", "contentId", "pageId"]) }
      : {}),
    ...(firstString(record, ["space.name", "space.key", "spaceName", "spaceKey"]) ?? false
      ? { space: firstString(record, ["space.name", "space.key", "spaceName", "spaceKey"]) }
      : {}),
    ...(url ? { url } : {}),
    ...(toIsoString(firstPresent(record, ["version.when", "updatedAt", "lastUpdated", "modifiedAt"])) ??
    false
      ? { updatedAt: toIsoString(firstPresent(record, ["version.when", "updatedAt", "lastUpdated", "modifiedAt"])) }
      : {}),
    ...(body ? { body } : {}),
  };
}

function normalizeFixVersions(value: unknown): FixVersion[] {
  const versions: FixVersion[] = [];
  for (const item of asArray(value)) {
    if (!isRecord(item)) continue;
    const name = firstString(item, ["name"]);
    if (!name) continue;
    const releaseDate = firstString(item, ["releaseDate"]);
    versions.push({
      name,
      ...(typeof item.released === "boolean" ? { released: item.released } : {}),
      ...(releaseDate ? { releaseDate } : {}),
    });
  }
  return versions;
}

/** Matches the display name of the Jira Service Management "Affected services" field. */
const AFFECTED_SERVICES_FIELD_NAME = /^affected services?$/i;
/** Matches the JSM change "Change completion date" field: when the deployment actually finished. */
const CHANGE_COMPLETION_FIELD_NAME = /^change completion date$/i;

/**
 * Custom-field ids differ per Jira site, so fields are located by display name
 * through the `names` map that `expand=names` returns.
 */
function fieldIdsByName(raw: unknown, issue: UnknownIssueRecord, pattern: RegExp): string[] {
  const names = isRecord(issue.names) ? issue.names : getPath(raw, "names");
  if (!isRecord(names)) {
    return [];
  }
  return Object.entries(names)
    .filter(([, fieldName]) => typeof fieldName === "string" && pattern.test(fieldName.trim()))
    .map(([fieldId]) => fieldId);
}

/**
 * Read the "Affected services" custom field. Jira Cloud returns its values as
 * id-only service refs; the display names are only in `renderedFields` (which
 * `expand=renderedFields` already fetches). Values with no name anywhere are
 * dropped rather than shown as opaque ids.
 */
function normalizeAffectedServices(raw: unknown, issue: UnknownIssueRecord, fields: Record<string, unknown>): string[] {
  const rendered = isRecord(issue.renderedFields) ? issue.renderedFields : getPath(raw, "renderedFields");
  const services: string[] = [];
  for (const fieldId of fieldIdsByName(raw, issue, AFFECTED_SERVICES_FIELD_NAME)) {
    services.push(...toStringArray(fields[fieldId]));
    if (isRecord(rendered)) services.push(...toStringArray(rendered[fieldId]));
  }
  return [...new Set(services)];
}

/**
 * When the change was actually completed: "Change completion date", else the
 * resolution date. Kept as Jira returns it (site-local offset), not converted
 * to UTC, so its `YYYY-MM-DD` prefix is the local day the team would name.
 */
function normalizeCompletedAt(raw: unknown, issue: UnknownIssueRecord, fields: Record<string, unknown>): string | undefined {
  for (const fieldId of fieldIdsByName(raw, issue, CHANGE_COMPLETION_FIELD_NAME)) {
    const value = fields[fieldId];
    if (isNonEmptyString(value)) return value.trim();
  }
  return isNonEmptyString(fields.resolutiondate) ? fields.resolutiondate.trim() : undefined;
}

function normalizePerson(value: unknown): Person | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const name = firstString(value, ["displayName", "name", "fullName", "publicName"]);
  const email = firstString(value, ["emailAddress", "email"]);
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

function findIssueRecord(raw: unknown, requestedKey: string): UnknownIssueRecord {
  const commonPaths = ["issue", "data.issue", "workItem", "jiraWorkItem", "object", "objects.0", "results.0", "values.0"];

  for (const path of commonPaths) {
    const candidate = getPath(raw, path);
    if (isRecord(candidate) && isIssueLike(candidate, requestedKey)) {
      return candidate;
    }
  }

  if (isRecord(raw) && isIssueLike(raw, requestedKey)) {
    return raw;
  }

  const found = collectObjects(raw, (record) => isIssueLike(record, requestedKey), 50)[0];
  if (found) {
    return found;
  }

  if (isRecord(raw)) {
    return raw;
  }

  return { key: requestedKey, summary: requestedKey, description: unknownToText(raw) };
}

function isIssueLike(record: UnknownIssueRecord, requestedKey: string): boolean {
  const key = firstString(record, ["key", "issueKey", "displayId", "fields.key"]);
  return key === requestedKey || Boolean(key && looksLikeJiraKey(key) && firstPresent(record, ["fields.summary", "summary", "title"]));
}

function looksLikeJiraKey(value: string): boolean {
  return /^[A-Z][A-Z0-9]+-\d+$/.test(value);
}

function normalizeUrl(record: UnknownIssueRecord): string | undefined {
  return (
    firstString(record, ["url", "webUrl", "self", "href", "_links.self"]) ??
    buildUrl(firstPresent(record, ["_links.base", "baseUrl"]), firstPresent(record, ["_links.webui", "_links.web"]))
  );
}

function compactCandidates(values: unknown[]): unknown[] {
  return values.filter((value) => value !== undefined && value !== null);
}

function optionalString(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value : undefined;
}

function collectNamedArrays(raw: unknown, names: string[]): unknown[] {
  const matches: unknown[] = [];
  const normalizedNames = new Set(names.map((name) => name.toLowerCase()));
  const visited = new Set<unknown>();

  function visit(value: unknown): void {
    if (value === null || value === undefined || visited.has(value)) {
      return;
    }

    if (typeof value === "object") {
      visited.add(value);
    }

    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }

    if (!isRecord(value)) {
      return;
    }

    for (const [key, child] of Object.entries(value)) {
      if (normalizedNames.has(key.toLowerCase()) && Array.isArray(child)) {
        matches.push(child);
      }

      visit(child);
    }
  }

  visit(raw);
  return matches;
}

function isRecordLikeBranch(value: unknown): boolean {
  return isRecord(value) && Boolean(firstString(value, ["name", "branchName", "displayId", "ref", "refName"]));
}

function isRecordLikePullRequest(value: unknown): boolean {
  return (
    isRecord(value) &&
    Boolean(firstString(value, ["title", "name", "summary"])) &&
    (firstPresent(value, ["source", "sourceBranch", "destination", "targetBranch", "fromRef", "toRef", "status", "state"]) !==
      undefined ||
      Boolean(normalizeUrl(value)))
  );
}
