import type { ContextPack, RetrievalCitation } from "../domain/contextPack/schema.js";

/**
 * Lexical knowledge index over a ContextPack's evidence corpus (M10f).
 *
 * Chunks the description, comments, Confluence bodies, related-ticket bodies,
 * and attachment analyses, then ranks them with BM25 for a query. Deterministic
 * and dependency-free (no embedding API), so it is fully unit-testable and the
 * tool-using Researcher (M10g) can call `search` as a retrieval tool. A
 * freshness-keyed module cache avoids rebuilding the index for the same
 * context.
 */

const MAX_CHUNK_CHARS = 1000;
const BM25_K1 = 1.5;
const BM25_B = 0.75;
const EXCERPT_CHARS = 240;

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "else", "of", "to", "in", "on", "for", "with",
  "as", "by", "at", "is", "are", "was", "were", "be", "been", "it", "its", "this", "that", "these",
  "those", "from", "into", "can", "will", "should", "must", "may", "not", "no", "do", "does", "done",
]);

export interface KnowledgeChunk {
  id: string;
  /** Node-style source id (mirrors the evidence graph): "description", "comment:42", … */
  source: string;
  /** Human-readable reference for citation. */
  reference: string;
  text: string;
}

export interface RetrievalResult {
  chunk: KnowledgeChunk;
  score: number;
}

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (token) => token.length > 1 && !STOPWORDS.has(token),
  );
}

/** Split a ContextPack's evidence into retrievable chunks. */
export function chunkContext(context: ContextPack): KnowledgeChunk[] {
  const chunks: KnowledgeChunk[] = [];

  const push = (source: string, reference: string, text: string): void => {
    for (const [index, part] of splitText(text).entries()) {
      chunks.push({ id: `${source}#${index}`, source, reference, text: part });
    }
  };

  push("description", `${context.ticket.key} description`, context.description.text);

  context.comments.forEach((comment, index) => {
    const who = comment.author?.name ?? `comment ${index + 1}`;
    push(`comment:${comment.id ?? index}`, `comment by ${who}`, comment.body);
  });

  for (const page of context.confluencePages) {
    if (page.body) push(`confluencePage:${page.id ?? page.title}`, `Confluence: ${page.title}`, page.body);
  }

  for (const related of context.relatedTickets ?? []) {
    if (related.description) {
      push(`relatedTicket:${related.key}`, `${related.key}: ${related.title}`, related.description);
    }
  }

  for (const attachment of context.attachments) {
    if (attachment.analysis) push(`attachment:${attachment.filename}`, `attachment: ${attachment.filename}`, attachment.analysis);
  }

  return chunks.filter((chunk) => chunk.text.trim().length > 0);
}

export class KnowledgeIndex {
  readonly chunks: KnowledgeChunk[];
  private readonly tokens: string[][];
  private readonly docFreq = new Map<string, number>();
  private readonly avgLength: number;

  constructor(chunks: KnowledgeChunk[]) {
    this.chunks = chunks;
    this.tokens = chunks.map((chunk) => tokenize(chunk.text));

    for (const docTokens of this.tokens) {
      for (const term of new Set(docTokens)) {
        this.docFreq.set(term, (this.docFreq.get(term) ?? 0) + 1);
      }
    }
    const totalLength = this.tokens.reduce((sum, t) => sum + t.length, 0);
    this.avgLength = this.tokens.length > 0 ? totalLength / this.tokens.length : 0;
  }

  get size(): number {
    return this.chunks.length;
  }

  /** BM25 search; returns up to `topK` chunks with a positive score, best first. */
  search(query: string, topK = 5): RetrievalResult[] {
    const queryTerms = tokenize(query);
    if (queryTerms.length === 0 || this.chunks.length === 0) {
      return [];
    }
    const n = this.chunks.length;

    const scored: RetrievalResult[] = this.chunks.map((chunk, docIndex) => {
      const docTokens = this.tokens[docIndex] ?? [];
      const docLength = docTokens.length;
      const termFreq = new Map<string, number>();
      for (const token of docTokens) {
        termFreq.set(token, (termFreq.get(token) ?? 0) + 1);
      }

      let score = 0;
      for (const term of queryTerms) {
        const freq = termFreq.get(term);
        if (!freq) continue;
        const df = this.docFreq.get(term) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        const denom = freq + BM25_K1 * (1 - BM25_B + (BM25_B * docLength) / (this.avgLength || 1));
        score += idf * ((freq * (BM25_K1 + 1)) / denom);
      }
      return { chunk, score };
    });

    return scored
      .filter((result) => result.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  /** Search and project the hits into ContextPack {@link RetrievalCitation}s. */
  searchCitations(query: string, topK = 5): RetrievalCitation[] {
    return this.search(query, topK).map((result) => toCitation(result.chunk));
  }
}

export function toCitation(chunk: KnowledgeChunk): RetrievalCitation {
  const excerpt = chunk.text.trim().slice(0, EXCERPT_CHARS);
  return { source: chunk.source, reference: chunk.reference, ...(excerpt ? { excerpt } : {}) };
}

const indexCache = new Map<string, KnowledgeIndex>();
const MAX_CACHE_ENTRIES = 16;

/**
 * Build (or reuse) the knowledge index for a context. The index is cached under
 * a freshness key derived from the ticket and its section sizes + generation
 * time, so re-building the same context returns the same instance.
 */
export function buildKnowledgeIndex(context: ContextPack): KnowledgeIndex {
  const key = freshnessKey(context);
  const cached = indexCache.get(key);
  if (cached) {
    return cached;
  }
  const index = new KnowledgeIndex(chunkContext(context));
  if (indexCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = indexCache.keys().next().value;
    if (oldest !== undefined) indexCache.delete(oldest);
  }
  indexCache.set(key, index);
  return index;
}

export function freshnessKey(context: ContextPack): string {
  return [
    context.ticket.key,
    context.provenance.generatedAt,
    context.description.text.length,
    context.comments.length,
    context.confluencePages.length,
    (context.relatedTickets ?? []).length,
    context.attachments.length,
    context.attachments.filter((a) => a.analysis).length,
  ].join("|");
}

function splitText(text: string): string[] {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  const out: string[] = [];
  for (const paragraph of paragraphs) {
    if (paragraph.length <= MAX_CHUNK_CHARS) {
      out.push(paragraph);
      continue;
    }
    for (let start = 0; start < paragraph.length; start += MAX_CHUNK_CHARS) {
      out.push(paragraph.slice(start, start + MAX_CHUNK_CHARS));
    }
  }
  return out;
}
