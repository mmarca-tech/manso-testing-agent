import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { marked } from "marked";

interface ConfluencePage {
  id: string;
  title: string;
  ancestors?: Array<{ id?: string }>;
  version?: { number?: number };
  _links?: { webui?: string };
}

interface ConfluenceAttachment {
  id: string;
  title?: string;
}

interface PublishedConfluencePage extends ConfluencePage {
  action: "Created" | "Updated";
}

interface ConfluenceListResponse<T> {
  results?: T[];
}

interface ChildPageLink {
  title: string;
  url: string;
}

interface DocsGroup {
  name: string;
  files: string[];
}

type MediaReferenceKind = "image" | "attachment";

interface MediaReference {
  key: string;
  source: string;
  localPath?: string;
  altOrText: string;
  kind: MediaReferenceKind;
}

interface UploadedMedia {
  fileName: string;
  altOrText: string;
  kind: MediaReferenceKind;
}

interface MediaRewriteResult {
  markdown: string;
  storageByToken: Map<string, string>;
}

const markdownOptions = {
  async: false,
  gfm: true,
} as const;

async function main(): Promise<void> {
  const docsRoot = resolve(getEnv("DOCS_ROOT", "docs"));
  const workDir = resolve(getEnv("CONFLUENCE_WORK_DIR", ".confluence-docs-work"));
  const dryRun = parseBoolean(getEnv("CONFLUENCE_DRY_RUN", "false"));
  const baseUrl = trimTrailingSlash(getEnv("CONFLUENCE_BASE_URL", "https://org.atlassian.net/wiki"));
  const spaceKey = requiredEnv("CONFLUENCE_SPACE_KEY");
  const parentPageId = requiredEnv("CONFLUENCE_PARENT_PAGE_ID");
  const titlePrefix = getEnv("CONFLUENCE_PAGE_TITLE_PREFIX", "");

  const client = new ConfluenceClient({
    baseUrl,
    spaceKey,
    email: getEnv("CONFLUENCE_EMAIL", ""),
    apiToken: getEnv("CONFLUENCE_API_TOKEN", ""),
    dryRun,
  });

  const markdownFiles = await collectMarkdownFiles(docsRoot);
  if (markdownFiles.length === 0) {
    console.log(`No Markdown files found under ${docsRoot}`);
    return;
  }

  const groups = groupByDocsSubfolder(docsRoot, markdownFiles);

  console.log(`Publishing ${markdownFiles.length} Markdown file(s) from ${docsRoot} to Confluence space ${spaceKey}`);
  console.log("Format: Markdown -> Confluence Storage Format");
  console.log(`Parent page: ${parentPageId}`);
  if (dryRun) {
    console.log("Dry run enabled. No Confluence API writes will be made.");
  }

  for (const group of groups) {
    const folderTitle = `${titlePrefix}${toTitleCase(group.name)}`;
    const folderPage = await client.upsertPage(folderTitle, parentPageId, createIndexStorage(folderTitle, []));
    const children: ChildPageLink[] = [];

    for (const markdownFile of group.files) {
      const source = await readFile(markdownFile, "utf8");
      const markdownTitle = getMarkdownTitle(source, markdownFile);
      const preferredPageTitle = `${titlePrefix}${markdownTitle}`;
      const fallbackPageTitle = `${folderTitle} - ${markdownTitle}`;
      const pageTitle = await client.resolvePublishTitle(preferredPageTitle, folderPage.id, fallbackPageTitle);
      const mediaRefs = collectMediaReferences(source, markdownFile);
      const pageForAttachments = mediaRefs.length > 0
        ? await client.ensurePage(pageTitle, folderPage.id)
        : undefined;
      const mediaMap = await prepareMedia(mediaRefs, pageForAttachments?.id, markdownFile, workDir, client);
      const storage = markdownToStorage(source, markdownFile, mediaMap);

      await writeStorageSnapshot(workDir, group.name, pageTitle, storage);
      const page = await client.upsertPage(pageTitle, folderPage.id, storage, pageForAttachments);
      children.push({ title: pageTitle, url: absoluteWebUrl(baseUrl, page) });

      console.log(`${page.action} page: ${folderTitle} / ${pageTitle}`);
    }

    const folderIndexStorage = createIndexStorage(folderTitle, children);
    await writeStorageSnapshot(workDir, group.name, folderTitle, folderIndexStorage);
    const updatedFolderPage = await client.upsertPage(folderTitle, parentPageId, folderIndexStorage, folderPage);
    console.log(`${updatedFolderPage.action} folder page: ${folderTitle}`);
  }
}

class ConfluenceClient {
  private readonly baseUrl: string;
  private readonly spaceKey: string;
  private readonly email: string;
  private readonly apiToken: string;
  private readonly dryRun: boolean;

  public constructor(options: {
    baseUrl: string;
    spaceKey: string;
    email: string;
    apiToken: string;
    dryRun: boolean;
  }) {
    this.baseUrl = options.baseUrl;
    this.spaceKey = options.spaceKey;
    this.email = options.email;
    this.apiToken = options.apiToken;
    this.dryRun = options.dryRun;
  }

  public async resolvePublishTitle(preferredTitle: string, parentId: string, fallbackTitle: string): Promise<string> {
    if (this.dryRun) {
      return preferredTitle;
    }

    const preferredMatches = await this.findPagesByTitle(preferredTitle);
    if (preferredMatches.length === 0 || preferredMatches.some((page) => parentIdOf(page) === parentId)) {
      return preferredTitle;
    }

    const fallbackMatches = await this.findPagesByTitle(fallbackTitle);
    if (fallbackMatches.length === 0 || fallbackMatches.some((page) => parentIdOf(page) === parentId)) {
      console.log(`Page title "${preferredTitle}" already exists outside expected parent ${parentId}. Using "${fallbackTitle}".`);
      return fallbackTitle;
    }

    throw new Error(
      `Both "${preferredTitle}" and fallback "${fallbackTitle}" already exist outside expected parent ${parentId}. ` +
      "Set CONFLUENCE_PAGE_TITLE_PREFIX to make generated documentation titles unique.",
    );
  }

  public async upsertPage(
    title: string,
    parentId: string,
    storage: string,
    existingPage?: PublishedConfluencePage,
  ): Promise<PublishedConfluencePage> {
    if (this.dryRun) {
      return {
        id: stableId(`${parentId}:${title}`),
        title,
        action: existingPage ? "Updated" : "Created",
        _links: { webui: `/dry-run/${encodeURIComponent(title)}` },
      };
    }

    if (!this.email || !this.apiToken) {
      throw new Error("CONFLUENCE_EMAIL and CONFLUENCE_API_TOKEN are required when dry run is disabled.");
    }

    const existing = existingPage ?? await this.findPage(title, parentId);
    if (existing) {
      const updated = await this.requestJson<ConfluencePage>(
        `/rest/api/content/${encodeURIComponent(existing.id)}`,
        "PUT",
        {
          id: existing.id,
          type: "page",
          title,
          version: { number: (existing.version?.number ?? 1) + 1 },
          body: createStorageBody(storage),
        },
      );

      return { ...updated, action: "Updated" };
    }

    const created = await this.requestJson<ConfluencePage>(
      "/rest/api/content",
      "POST",
      {
        type: "page",
        title,
        space: { key: this.spaceKey },
        ancestors: [{ id: parentId }],
        body: createStorageBody(storage),
      },
    );

    return { ...created, action: "Created" };
  }

  public async ensurePage(title: string, parentId: string): Promise<PublishedConfluencePage> {
    if (this.dryRun) {
      return this.upsertPage(title, parentId, createPlaceholderStorage(title));
    }

    const existing = await this.findPage(title, parentId);
    if (existing) {
      return { ...existing, action: "Updated" };
    }

    return this.upsertPage(title, parentId, createPlaceholderStorage(title));
  }

  public async uploadAttachment(pageId: string, filePath: string, fileName: string): Promise<ConfluenceAttachment> {
    if (this.dryRun) {
      return {
        id: stableId(`${pageId}:${fileName}`),
        title: fileName,
      };
    }

    const existing = await this.getAttachmentByFilename(pageId, fileName);
    const path = existing
      ? `/rest/api/content/${encodeURIComponent(pageId)}/child/attachment/${encodeURIComponent(existing.id)}/data`
      : `/rest/api/content/${encodeURIComponent(pageId)}/child/attachment`;
    const buffer = await readFile(filePath);
    const form = new FormData();
    form.append("file", new Blob([buffer], { type: contentTypeFor(fileName) }), fileName);

    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "authorization": `Basic ${Buffer.from(`${this.email}:${this.apiToken}`).toString("base64")}`,
        "x-atlassian-token": "no-check",
      },
      body: form,
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Confluence attachment upload failed with ${response.status}: ${text.slice(0, 1000)}`);
    }

    return await this.getAttachmentByFilename(pageId, fileName) ?? {
      id: stableId(`${pageId}:${fileName}`),
      title: fileName,
    };
  }

  private async findPage(title: string, parentId: string): Promise<ConfluencePage | undefined> {
    const pages = await this.findPagesByTitle(title);
    return pages.find((page) => parentIdOf(page) === parentId);
  }

  private async findPagesByTitle(title: string): Promise<ConfluencePage[]> {
    const query = new URLSearchParams({
      spaceKey: this.spaceKey,
      title,
      type: "page",
      status: "current",
      expand: "ancestors,version,_links",
      limit: "50",
    });
    const response = await this.requestJson<ConfluenceListResponse<ConfluencePage>>(`/rest/api/content?${query}`, "GET");
    return response.results ?? [];
  }

  private async getAttachmentByFilename(pageId: string, fileName: string): Promise<ConfluenceAttachment | undefined> {
    if (this.dryRun) {
      return undefined;
    }

    const query = new URLSearchParams({
      filename: fileName,
      limit: "50",
    });
    const response = await this.requestJson<ConfluenceListResponse<ConfluenceAttachment>>(
      `/rest/api/content/${encodeURIComponent(pageId)}/child/attachment?${query}`,
      "GET",
    );
    return response.results?.find((attachment) => attachment.title === fileName);
  }

  private async requestJson<T>(path: string, method: "GET" | "POST" | "PUT", body?: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "accept": "application/json",
        "authorization": `Basic ${Buffer.from(`${this.email}:${this.apiToken}`).toString("base64")}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Confluence ${method} ${path} failed with ${response.status}: ${text.slice(0, 1000)}`);
    }

    return text.length === 0 ? {} as T : JSON.parse(text) as T;
  }
}

function parentIdOf(page: ConfluencePage): string | undefined {
  return page.ancestors?.at(-1)?.id;
}

function createStorageBody(storage: string): object {
  return {
    storage: {
      value: storage,
      representation: "storage",
    },
  };
}

async function prepareMedia(
  refs: MediaReference[],
  pageId: string | undefined,
  markdownFile: string,
  workDir: string,
  client: ConfluenceClient,
): Promise<Map<string, UploadedMedia>> {
  const media = new Map<string, UploadedMedia>();

  for (const ref of refs) {
    if (!ref.localPath) {
      continue;
    }

    if (!existsSync(ref.localPath)) {
      throw new Error(`Markdown media not found: ${ref.source} in ${markdownFile}`);
    }

    if (!pageId) {
      throw new Error(`Markdown media references require an existing Confluence page before upload: ${markdownFile}`);
    }

    const fileName = stableAttachmentFileName(ref.source);
    await copyMediaSnapshot(ref.localPath, fileName, pageId, workDir);
    const uploaded = await client.uploadAttachment(pageId, ref.localPath, fileName);
    media.set(ref.key, {
      fileName: uploaded.title ?? fileName,
      altOrText: ref.altOrText,
      kind: ref.kind,
    });
  }

  return media;
}

async function copyMediaSnapshot(localPath: string, fileName: string, pageId: string, workDir: string): Promise<void> {
  const outputDir = join(workDir, "media", pageId);
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, fileName), await readFile(localPath));
}

async function collectMarkdownFiles(root: string): Promise<string[]> {
  const files: string[] = [];

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        files.push(fullPath);
      }
    }
  }

  await visit(root);
  return files.sort((left, right) => left.localeCompare(right));
}

function groupByDocsSubfolder(root: string, files: string[]): DocsGroup[] {
  const groups = new Map<string, string[]>();
  for (const file of files) {
    const parts = relative(root, file).split(/[\\/]+/u);
    const groupName = parts.length > 1 ? parts[0] ?? "docs" : "docs";
    const groupFiles = groups.get(groupName) ?? [];
    groupFiles.push(file);
    groups.set(groupName, groupFiles);
  }

  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, groupFiles]) => ({ name, files: groupFiles.sort((left, right) => left.localeCompare(right)) }));
}

function getMarkdownTitle(source: string, filePath: string): string {
  const match = /^#\s+(.+)$/mu.exec(source);
  return match?.[1] ? stripInlineMarkdown(match[1]).trim() : toTitleCase(basename(filePath, ".md"));
}

function markdownToStorage(source: string, markdownFile: string, mediaMap: Map<string, UploadedMedia>): string {
  const rewritten = rewriteMediaReferences(source, markdownFile, mediaMap);
  const storage = marked.parse(rewritten.markdown, markdownOptions) as string;
  return injectStorageTokens(storage, rewritten.storageByToken);
}

function createIndexStorage(title: string, children: ChildPageLink[]): string {
  const links = children.length === 0
    ? ""
    : `<ul>${children.map((child) => `<li><a href="${escapeXmlAttribute(child.url)}">${escapeXmlText(child.title)}</a></li>`).join("")}</ul>`;

  return [
    `<h1>${escapeXmlText(title)}</h1>`,
    "<p>Published from repository Markdown files.</p>",
    links,
  ].join("\n");
}

function createPlaceholderStorage(title: string): string {
  return [
    `<h1>${escapeXmlText(title)}</h1>`,
    "<p>Preparing attachments before publishing the final page.</p>",
  ].join("\n");
}

async function writeStorageSnapshot(workDir: string, groupName: string, title: string, storage: string): Promise<void> {
  const outputDir = join(workDir, "storage", safeFileName(groupName));
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, `${safeFileName(title)}.storage.html`), storage, "utf8");
}

function stripInlineMarkdown(value: string): string {
  return value
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
    .replace(/[*_~#]/gu, "");
}

function collectMediaReferences(source: string, markdownFile: string): MediaReference[] {
  const refs = new Map<string, MediaReference>();
  const imageRegex = /!\[(?<alt>[^\]]*)\]\((?<src><[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\)/gu;
  const linkRegex = /(?<!!)\[(?<text>[^\]]+)\]\((?<src><[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\)/gu;

  forEachMarkdownContentSegment(source, (segment) => {
    for (const match of segment.matchAll(imageRegex)) {
      const src = cleanMarkdownUrl(match.groups?.src ?? "");
      const ref = resolveMediaReference(src, markdownFile, match.groups?.alt ?? "", "image");
      if (ref) {
        refs.set(ref.key, ref);
      }
    }

    for (const match of segment.matchAll(linkRegex)) {
      const src = cleanMarkdownUrl(match.groups?.src ?? "");
      if (!isSupportedAttachmentSource(src)) {
        continue;
      }

      const ref = resolveMediaReference(src, markdownFile, match.groups?.text ?? "", "attachment");
      if (ref) {
        refs.set(ref.key, ref);
      }
    }
  });

  return [...refs.values()];
}

function rewriteMediaReferences(
  source: string,
  markdownFile: string,
  mediaMap: Map<string, UploadedMedia>,
): MediaRewriteResult {
  const storageByToken = new Map<string, string>();
  const createToken = (storage: string): string => {
    const token = `CONFLUENCE_MEDIA_${storageByToken.size}_${stableId(storage).toUpperCase()}`;
    storageByToken.set(token, storage);
    return token;
  };

  const withImages = rewriteMarkdownContentSegments(
    source,
    (segment) => segment.replace(
      /!\[(?<alt>[^\]]*)\]\((?<src><[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\)/gu,
      (
        markdown,
        _alt: string,
        _src: string,
        _offset: number,
        _source: string,
        groups?: { alt?: string; src?: string },
      ) => {
        const src = cleanMarkdownUrl(groups?.src ?? "");
        const ref = resolveMediaReference(src, markdownFile, groups?.alt ?? "", "image");
        if (!ref) {
          return markdown;
        }

        if (!ref.localPath && isRemoteUrl(src)) {
          return createToken(confluenceImageStorage(ref.altOrText, { url: src }));
        }

        const uploaded = mediaMap.get(ref.key);
        return uploaded
          ? createToken(confluenceImageStorage(uploaded.altOrText, { attachmentFileName: uploaded.fileName }))
          : markdown;
      },
    ),
  );

  const markdown = rewriteMarkdownContentSegments(
    withImages,
    (segment) => segment.replace(
      /(?<!!)\[(?<text>[^\]]+)\]\((?<src><[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\)/gu,
      (
        markdown,
        _text: string,
        _src: string,
        _offset: number,
        _source: string,
        groups?: { text?: string; src?: string },
      ) => {
        const src = cleanMarkdownUrl(groups?.src ?? "");
        if (!isSupportedAttachmentSource(src)) {
          return markdown;
        }

        const ref = resolveMediaReference(src, markdownFile, groups?.text ?? "", "attachment");
        if (!ref?.localPath) {
          return markdown;
        }

        const uploaded = mediaMap.get(ref.key);
        return uploaded
          ? createToken(confluenceAttachmentLinkStorage(uploaded.fileName, uploaded.altOrText))
          : markdown;
      },
    ),
  );

  return { markdown, storageByToken };
}

function injectStorageTokens(storage: string, storageByToken: Map<string, string>): string {
  let output = storage;

  for (const [token, storageValue] of storageByToken) {
    const paragraphToken = new RegExp(`<p>\\s*${escapeRegExp(token)}\\s*</p>`, "gu");
    output = output.replace(paragraphToken, () => storageValue);
    output = output.split(token).join(storageValue);
  }

  return output;
}

function confluenceImageStorage(
  alt: string,
  source: { attachmentFileName: string } | { url: string },
): string {
  const imageSource = "attachmentFileName" in source
    ? `<ri:attachment ri:filename="${escapeXmlAttribute(source.attachmentFileName)}" />`
    : `<ri:url ri:value="${escapeXmlAttribute(source.url)}" />`;
  return `<ac:image ac:alt="${escapeXmlAttribute(alt)}">${imageSource}</ac:image>`;
}

function confluenceAttachmentLinkStorage(fileName: string, linkText: string): string {
  return `<ac:link><ri:attachment ri:filename="${escapeXmlAttribute(fileName)}" /><ac:plain-text-link-body><![CDATA[${escapeCData(linkText)}]]></ac:plain-text-link-body></ac:link>`;
}

function forEachMarkdownContentSegment(source: string, visit: (segment: string) => void): void {
  let cursor = 0;
  for (const range of collectProtectedMarkdownRanges(source)) {
    if (range.start > cursor) {
      visit(source.slice(cursor, range.start));
    }
    cursor = range.end;
  }

  if (cursor < source.length) {
    visit(source.slice(cursor));
  }
}

function rewriteMarkdownContentSegments(source: string, transform: (segment: string) => string): string {
  let cursor = 0;
  let output = "";

  for (const range of collectProtectedMarkdownRanges(source)) {
    if (range.start > cursor) {
      output += transform(source.slice(cursor, range.start));
    }

    output += source.slice(range.start, range.end);
    cursor = range.end;
  }

  if (cursor < source.length) {
    output += transform(source.slice(cursor));
  }

  return output;
}

function collectProtectedMarkdownRanges(source: string): Array<{ start: number; end: number }> {
  const fencedRanges = collectFencedCodeRanges(source);
  const ranges = [...fencedRanges];
  const inlineCodeRegex = /(?<ticks>`+)[^`\n]*?\k<ticks>/gu;

  for (const match of source.matchAll(inlineCodeRegex)) {
    const range = {
      start: match.index,
      end: match.index + match[0].length,
    };

    if (!overlapsAnyRange(range, fencedRanges)) {
      ranges.push(range);
    }
  }

  return mergeRanges(ranges);
}

function collectFencedCodeRanges(source: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const fenceRegex = /(^|\n)(?<fence>`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\k<fence>(?=\n|$)/gu;

  for (const match of source.matchAll(fenceRegex)) {
    ranges.push({
      start: match.index,
      end: match.index + match[0].length,
    });
  }

  return ranges;
}

function overlapsAnyRange(range: { start: number; end: number }, ranges: Array<{ start: number; end: number }>): boolean {
  return ranges.some((candidate) => range.start < candidate.end && range.end > candidate.start);
}

function mergeRanges(ranges: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
  const sortedRanges = ranges.sort((left, right) => left.start - right.start);
  const merged: Array<{ start: number; end: number }> = [];

  for (const range of sortedRanges) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }

  return merged;
}

function resolveMediaReference(
  src: string,
  markdownFile: string,
  altOrText: string,
  kind: MediaReferenceKind,
): MediaReference | undefined {
  if (src.length === 0 || src.toLowerCase().startsWith("data:")) {
    return undefined;
  }

  if (isRemoteUrl(src)) {
    return { key: src, source: src, altOrText, kind };
  }

  const cleanSrc = src.split(/[?#]/u, 1)[0] ?? src;
  const decodedSrc = decodeURIComponent(cleanSrc);
  const localPath = resolve(join(dirname(markdownFile), decodedSrc));
  return {
    key: localPath.toLowerCase(),
    source: src,
    localPath,
    altOrText,
    kind,
  };
}

function cleanMarkdownUrl(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1) : trimmed;
}

function isRemoteUrl(value: string): boolean {
  return /^https?:\/\//iu.test(value);
}

function isSupportedAttachmentSource(value: string): boolean {
  if (value.length === 0 || isRemoteUrl(value) || value.toLowerCase().startsWith("data:")) {
    return false;
  }

  return [".mmd", ".svg"].includes(extensionOfUrl(value));
}

function stableAttachmentFileName(sourcePath: string): string {
  const cleanSourcePath = cleanMarkdownUrl(sourcePath).split(/[?#]/u, 1)[0] ?? sourcePath;
  const decodedSourcePath = decodeURIComponent(cleanSourcePath);
  const normalizedSourcePath = decodedSourcePath.replace(/\\/gu, "/").toLowerCase();
  const extension = extensionOfUrl(decodedSourcePath);
  const base = basename(decodedSourcePath, extension);
  const hash = stableId(normalizedSourcePath).slice(0, 8);
  return `${safeFileName(base)}-${hash}${extension}`;
}

function extensionOfUrl(value: string): string {
  const clean = value.split(/[?#]/u, 1)[0] ?? value;
  const match = /\.[^.\\/]+$/u.exec(clean);
  return match?.[0]?.toLowerCase() ?? "";
}

function contentTypeFor(fileName: string): string {
  switch (extensionOfUrl(fileName)) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    case ".mmd":
      return "text/plain";
    default:
      return "application/octet-stream";
  }
}

function escapeCData(value: string): string {
  return value.replace(/\]\]>/gu, "]]]]><![CDATA[>");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function toTitleCase(value: string): string {
  const normalized = value.replace(/[-_]/gu, " ").replace(/\s+/gu, " ").trim();
  return normalized.replace(/\b\w/gu, (match) => match.toUpperCase());
}

function absoluteWebUrl(baseUrl: string, page: ConfluencePage): string {
  const webUi = page._links?.webui;
  if (!webUi) {
    return `${baseUrl}/pages/${encodeURIComponent(page.id)}`;
  }

  return /^https?:\/\//iu.test(webUi) ? webUi : `${baseUrl}${webUi}`;
}

function safeFileName(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return safe.length === 0 ? "page" : safe.slice(0, 120);
}

function stableId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value)
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

function getEnv(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value.trim().length === 0 ? fallback : value;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} is required.`);
  }

  return value;
}

function parseBoolean(value: string): boolean {
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
