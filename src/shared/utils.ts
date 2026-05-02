export type UnknownRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }

  return value === undefined || value === null ? [] : [value];
}

export function getPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (Array.isArray(current)) {
      const index = Number.parseInt(segment, 10);
      return Number.isInteger(index) ? current[index] : undefined;
    }

    if (!isRecord(current)) {
      return undefined;
    }

    return current[segment];
  }, value);
}

export function firstString(value: unknown, paths: string[]): string | undefined {
  for (const path of paths) {
    const candidate = getPath(value, path);
    if (isNonEmptyString(candidate)) {
      return candidate.trim();
    }
  }

  return undefined;
}

export function toStringArray(value: unknown): string[] {
  return asArray(value)
    .map((item) => {
      if (isNonEmptyString(item)) {
        return item.trim();
      }

      if (isRecord(item)) {
        return firstString(item, ["name", "value", "key", "displayName", "title"]);
      }

      return undefined;
    })
    .filter((item): item is string => Boolean(item));
}

export function compactStrings(values: Array<string | undefined>): string[] {
  return values.filter((value): value is string => Boolean(value && value.trim().length > 0));
}

export function toIsoString(value: unknown): string | undefined {
  if (!isNonEmptyString(value)) {
    return undefined;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

export function uniqueBy<T>(items: T[], keyFn: (item: T) => string | undefined): T[] {
  const seen = new Set<string>();
  const output: T[] = [];

  for (const item of items) {
    const key = keyFn(item);
    if (!key) {
      output.push(item);
      continue;
    }

    const normalized = key.toLowerCase();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      output.push(item);
    }
  }

  return output;
}

export function stripHtml(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function unknownToText(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }

  if (typeof value === "string") {
    return value.includes("<") && value.includes(">") ? stripHtml(value) : value.trim();
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value.map(unknownToText).filter(Boolean).join("\n").trim();
  }

  if (!isRecord(value)) {
    return "";
  }

  const bodyCandidate = firstPresent(value, [
    "body.storage.value",
    "body.view.value",
    "body.export_view.value",
    "body.atlas_doc_format.value",
    "storage.value",
    "view.value",
    "atlas_doc_format.value",
    "description",
    "text",
    "value",
  ]);

  if (bodyCandidate !== undefined && bodyCandidate !== value) {
    return unknownToText(bodyCandidate);
  }

  if (value.type === "doc" || value.content !== undefined) {
    return adfToText(value).trim();
  }

  return JSON.stringify(value, null, 2);
}

export function detectTextFormat(value: unknown): "text" | "markdown" | "adf" | "html" | "unknown" {
  if (isRecord(value) && (value.type === "doc" || value.content !== undefined)) {
    return "adf";
  }

  if (typeof value === "string") {
    if (value.includes("<") && value.includes(">")) {
      return "html";
    }

    if (/^#{1,6}\s|\[[^\]]+\]\([^)]+\)|```/m.test(value)) {
      return "markdown";
    }

    return "text";
  }

  return "unknown";
}

export function firstPresent(value: unknown, paths: string[]): unknown {
  for (const path of paths) {
    const candidate = getPath(value, path);
    if (candidate !== undefined && candidate !== null) {
      return candidate;
    }
  }

  return undefined;
}

export function collectObjects(
  value: unknown,
  predicate: (record: UnknownRecord) => boolean,
  maxItems = 500,
): UnknownRecord[] {
  const output: UnknownRecord[] = [];
  const visited = new Set<unknown>();

  function visit(current: unknown): void {
    if (output.length >= maxItems || current === null || current === undefined || visited.has(current)) {
      return;
    }

    if (typeof current === "object") {
      visited.add(current);
    }

    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }

    if (!isRecord(current)) {
      return;
    }

    if (predicate(current)) {
      output.push(current);
    }

    Object.values(current).forEach(visit);
  }

  visit(value);
  return output;
}

export function buildUrl(base: unknown, path: unknown): string | undefined {
  if (!isNonEmptyString(path)) {
    return undefined;
  }

  if (/^https?:\/\//i.test(path)) {
    return path;
  }

  if (!isNonEmptyString(base)) {
    return path;
  }

  return `${base.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

function adfToText(value: unknown): string {
  const parts: string[] = [];

  function visit(current: unknown): void {
    if (current === undefined || current === null) {
      return;
    }

    if (typeof current === "string") {
      return;
    }

    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }

    if (!isRecord(current)) {
      return;
    }

    if (isNonEmptyString(current.text)) {
      parts.push(current.text);
    } else if (isRecord(current.attrs) && isNonEmptyString(current.attrs.text)) {
      parts.push(current.attrs.text);
    }

    if (current.type === "paragraph" || current.type === "heading" || current.type === "listItem") {
      parts.push("\n");
    }

    visit(current.content);
  }

  visit(value);
  return parts.join(" ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
}
