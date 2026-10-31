import type { TicketSource } from "../workflows/ticket-context/ticketSource.js";

/**
 * A pluggable source of ticket-shaped context.
 *
 * `ContextProvider` is the single seam every context source implements; the
 * first implementation is {@link AtlassianRestSource} (Jira + Confluence REST).
 * When non-Jira providers land (Rovo MCP, GitHub, ...) they implement this same
 * interface and the `getSourceName` return type widens.
 */
export type ContextProvider = TicketSource;

/** Identifier returned by {@link ContextProvider.getSourceName}. */
export type ContextProviderName = string;

/**
 * Holds the providers configured for a run and looks them up by source name.
 * Multiple providers can be registered side-by-side; the orchestrator chooses
 * which to call (REST default for CI, MCP when interactive, ...).
 */
export class ProviderRegistry {
  private readonly providers = new Map<ContextProviderName, ContextProvider>();

  register(provider: ContextProvider): void {
    this.providers.set(provider.getSourceName(), provider);
  }

  get(name: ContextProviderName): ContextProvider | undefined {
    return this.providers.get(name);
  }

  has(name: ContextProviderName): boolean {
    return this.providers.has(name);
  }

  list(): ContextProvider[] {
    return [...this.providers.values()];
  }

  /** Close every registered provider, swallowing per-provider errors. */
  async closeAll(): Promise<void> {
    await Promise.allSettled(this.list().map((provider) => provider.close()));
  }
}
