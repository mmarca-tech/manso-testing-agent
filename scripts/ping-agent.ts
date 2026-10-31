#!/usr/bin/env node
/**
 * Verify the *implementation-phase* code agent is reachable. Resolves whatever
 * runner the config produces (Claude Agent SDK when implementation provider is
 * anthropic, Codex SDK when openai) and runs one trivial turn in a temp dir.
 *
 * Run with:  npx tsx scripts/ping-agent.ts
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRuntimeConfig } from "../src/config/runtimeConfig.js";
import { resolveImplementationAgentRunners } from "../src/integrations/llm/agentRunner.js";
import { loadEnv } from "../src/shared/loadEnv.js";

loadEnv();

async function main(): Promise<void> {
  const runtime = await loadRuntimeConfig();
  const implLlm = runtime.implementationLlm ?? runtime.llm;

  console.log("Implementation agent config:");
  console.log("  source:  ", runtime.implementationLlm ? "implementationLlm override" : "design llm fallback");
  console.log("  provider:", implLlm?.provider ?? "(none resolved)");
  console.log("  model:   ", implLlm?.model ?? "(none)");
  console.log("  baseUrl: ", implLlm?.baseUrl ?? "(default)");
  console.log("---");

  const { implementation } = resolveImplementationAgentRunners({}, runtime);
  console.log("Resolved runner kind:", implementation.kind);
  if (implementation.model) {
    console.log("Runner model:       ", implementation.model);
  }
  console.log("---");

  const workDir = await mkdtemp(join(tmpdir(), "manso-agent-ping-"));
  const started = Date.now();
  try {
    console.log("Sending a trivial prompt to the agent...");
    const result = await implementation.run({
      issueKey: "PING-1",
      repoRoot: workDir,
      prompt:
        "Reply with the single word OK and then stop. Do not create, edit, or delete any files.",
      env: process.env,
      phase: "implementation",
    });

    const ms = Date.now() - started;
    console.log(`Agent turn finished in ${ms} ms with exit code ${result.exitCode}.`);
    if (result.usage) {
      console.log("Usage:", JSON.stringify(result.usage));
    }
    if (result.stdout) {
      console.log("--- stdout (truncated) ---");
      console.log(result.stdout.slice(0, 2000));
    }
    if (result.stderr) {
      console.log("--- stderr (truncated) ---");
      console.log(result.stderr.slice(0, 2000));
    }

    if (result.exitCode === 0) {
      console.log("---");
      console.log(`Agent runner (${implementation.kind}) is reachable.`);
    } else {
      console.error("---");
      console.error(`Agent runner returned a non-zero exit code (${result.exitCode}).`);
      process.exit(1);
    }
  } catch (error) {
    console.error(`Agent run threw after ${Date.now() - started} ms:`);
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  } finally {
    await rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
