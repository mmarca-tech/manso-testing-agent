import type { ContextPack, EvidenceGraphEdge, EvidenceGraphNode } from "../domain/contextPack/schema.js";

/** A typed node/edge graph linking a ticket to every piece of evidence. */
export interface EvidenceGraph {
  nodes: EvidenceGraphNode[];
  edges: EvidenceGraphEdge[];
}

/**
 * Assemble the traceability backbone from an assembled {@link ContextPack}.
 *
 * Pure and idempotent: the Researcher builds it from the base context, and the
 * Test Architect rebuilds it once acceptance criteria exist so `requirement`
 * nodes and their evidence edges appear. Node ids are stable and namespaced
 * (`ticket:KEY`, `requirement:AC-1`, `confluencePage:…`) so edges can reference
 * them and later retrieval (M10f) / the tool-using Researcher (M10g) can walk
 * the graph.
 *
 * Edge vocabulary (ticket-centred): `specifies` (→ requirement), `discussedIn`
 * (→ comment), `documentedBy` (→ Confluence), `coveredBy` (→ Xray test),
 * `hasAttachment`, `implementedIn` (→ branch/PR), the link relationship (→
 * related ticket), and `evidencedBy` (requirement → its source).
 */
export function buildEvidenceGraph(context: ContextPack): EvidenceGraph {
  const nodes = new Map<string, EvidenceGraphNode>();
  const edges: EvidenceGraphEdge[] = [];
  const edgeKeys = new Set<string>();

  const addNode = (type: string, id: string, label?: string): void => {
    if (!nodes.has(id)) {
      nodes.set(id, { type, id, ...(label ? { label: label.trim() } : {}) });
    }
  };
  const addEdge = (from: string, to: string, type: string): void => {
    const key = `${from}|${type}|${to}`;
    if (!edgeKeys.has(key)) {
      edgeKeys.add(key);
      edges.push({ from, to, type });
    }
  };

  const ticketId = `ticket:${context.ticket.key}`;
  addNode("ticket", ticketId, context.ticket.title);

  // Comments and Confluence first so requirement evidence edges can reference
  // already-registered nodes.
  context.comments.forEach((comment, index) => {
    const id = `comment:${comment.id ?? index}`;
    addNode("comment", id, comment.author?.name ?? comment.createdAt ?? `comment ${index + 1}`);
    addEdge(ticketId, id, "discussedIn");
  });

  for (const page of context.confluencePages) {
    const id = `confluencePage:${page.id ?? page.url ?? page.title}`;
    addNode("confluencePage", id, page.title);
    addEdge(ticketId, id, "documentedBy");
  }

  for (const criterion of context.acceptanceCriteria ?? []) {
    const reqId = `requirement:${criterion.id}`;
    addNode("requirement", reqId, criterion.text);
    addEdge(ticketId, reqId, "specifies");

    const source = criterion.source?.trim().toLowerCase();
    if (source?.startsWith("comment:")) {
      const commentNodeId = `comment:${criterion.source!.trim().slice("comment:".length)}`;
      if (nodes.has(commentNodeId)) {
        addEdge(reqId, commentNodeId, "evidencedBy");
      }
    } else if (source === "description" || source?.startsWith("description")) {
      addEdge(reqId, ticketId, "evidencedBy");
    }
  }

  for (const related of context.relatedTickets ?? []) {
    const id = `ticket:${related.key}`;
    addNode("ticket", id, related.title);
    addEdge(ticketId, id, related.relationship ?? "relatesTo");
  }

  for (const test of context.xrayTestCases) {
    const id = `xrayTest:${test.key}`;
    addNode("xrayTest", id, test.title);
    addEdge(ticketId, id, "coveredBy");
  }

  for (const attachment of context.attachments) {
    const id = `attachment:${attachment.id ?? attachment.filename}`;
    addNode("attachment", id, attachment.filename);
    addEdge(ticketId, id, "hasAttachment");
  }

  for (const branch of context.development.branches) {
    const id = `branch:${branch.url ?? branch.name}`;
    addNode("branch", id, branch.name);
    addEdge(ticketId, id, "implementedIn");
  }

  for (const pr of context.development.pullRequests) {
    const id = `pullRequest:${pr.url ?? pr.title}`;
    addNode("pullRequest", id, pr.title);
    addEdge(ticketId, id, "implementedIn");
  }

  return { nodes: [...nodes.values()], edges };
}
