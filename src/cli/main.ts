#!/usr/bin/env node
import { CliError, handleCliError, isCliEntrypoint } from "../shared/cli.js";
import { loadEnv } from "../shared/loadEnv.js";
import { readVersion } from "./version.js";
import { runWithCliMemory } from "../memory/cliSession.js";

/** A CLI verb implementation. `run` receives the args after the verb and
 * returns a process exit code (0 = success). */
export interface CommandModule {
  run(argv: string[]): Promise<number>;
}

/**
 * Every verb in Manso's planned CLI surface. Listing them here lets the
 * dispatcher distinguish a not-yet-implemented verb from a typo. Each verb is
 * wired into `COMMANDS` as its milestone lands.
 */
export const KNOWN_COMMANDS = [
  "init",
  "check",
  "fetch",
  "skills",
  "design-tests",
  "implement-tests",
  "analyse-coverage",
  "respond-to-pr",
  "review-pull-request",
  "generate-release-notes",
  "eval",
  "audit",
] as const;

export type KnownCommand = (typeof KNOWN_COMMANDS)[number];

/** Lazily-loaded verb implementations, populated milestone by milestone. */
const COMMANDS: Partial<Record<KnownCommand, () => Promise<CommandModule>>> = {
  init: async () => (await import("./init.js")).default,
  check: async () => (await import("./check.js")).default,
  fetch: async () => (await import("./fetch.js")).default,
  skills: async () => (await import("./skills.js")).default,
  "design-tests": async () => (await import("./designTests.js")).default,
  "implement-tests": async () => (await import("./implementTests.js")).default,
  "analyse-coverage": async () => (await import("./analyseCoverage.js")).default,
  "respond-to-pr": async () => (await import("./respondToPr.js")).default,
  "review-pull-request": async () => (await import("./reviewPullRequest.js")).default,
  "generate-release-notes": async () => (await import("./generateReleaseNotes.js")).default,
  eval: async () => (await import("./eval.js")).default,
  audit: async () => (await import("./audit.js")).default,
};

const HELP = `Manso - an end-to-end AI testing agent.

Usage:
  manso <command> [options]
  manso --version
  manso --help

Commands:
  init             Scaffold the .agents/ folder in a target repository
  check            Score a repository's Manso readiness
  fetch            Fetch a Jira ticket through the Context Layer (diagnostic)
  skills           List resolved skills (debug)
  design-tests     Extract ticket context and design tests
  implement-tests  Implement automated tests in a repository
  analyse-coverage Analyse test coverage gaps for a user story
  respond-to-pr    Respond to a PR comment or @manso mention
  review-pull-request Review a PR diff; post inline findings and one summary
  generate-release-notes  Generate release notes for a Jira release ticket
  eval             Run the evaluation harness
  audit            Read Manso's append-only audit log

Run "manso <command> --help" for command-specific options.
`;

function isKnownCommand(value: string): value is KnownCommand {
  return (KNOWN_COMMANDS as readonly string[]).includes(value);
}

/**
 * Flush buffered telemetry spans if (and only if) a command activated
 * telemetry. The state flag is a tiny leaf module, so checking it does not pull
 * in the OpenTelemetry stack; the heavy flush module is imported lazily.
 */
async function flushTelemetryIfActive(): Promise<void> {
  const { isTelemetryActive } = await import("../integrations/llm/telemetry/state.js");
  if (!isTelemetryActive()) {
    return;
  }
  const { flushTelemetry } = await import("../integrations/llm/telemetry/observability.js");
  await flushTelemetry();
}

/**
 * Dispatch a Manso CLI invocation. Pure with respect to the process — it
 * returns an exit code instead of calling `process.exit`, so it is directly
 * testable.
 */
export async function runCli(argv: string[]): Promise<number> {
  const first = argv[0];

  if (first === undefined || first === "help" || first === "--help" || first === "-h") {
    console.log(HELP);
    return 0;
  }

  if (first === "--version" || first === "-v") {
    console.log(readVersion());
    return 0;
  }

  const loader = isKnownCommand(first) ? COMMANDS[first] : undefined;
  if (loader) {
    const command = await loader();
    try {
      return await runWithCliMemory(first, argv.slice(1), () => command.run(argv.slice(1)));
    } catch (error) {
      if (error instanceof CliError) {
        console.error(error.message);
        return 1;
      }
      throw error;
    } finally {
      // Flush buffered OTel spans (Phoenix/Langfuse) before the process exits.
      // No-op unless a command actually activated telemetry, so lightweight
      // verbs never load the OpenTelemetry stack.
      await flushTelemetryIfActive();
    }
  }

  if (isKnownCommand(first)) {
    console.error(`Command "${first}" is planned but not implemented yet.`);
    return 1;
  }

  console.error(`Unknown command: "${first}". Run "manso --help" for usage.`);
  return 1;
}

if (isCliEntrypoint(import.meta.url)) {
  // Load .env only for real CLI invocations — keeps the library surface (and
  // the test suite) free of ambient .env pollution. Fills in unset/empty vars
  // without clobbering real environment values (see loadEnv docs).
  loadEnv();
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch(handleCliError);
}
