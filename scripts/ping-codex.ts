#!/usr/bin/env node
/**
 * Verify the Codex SDK can negotiate a single turn against the LLM endpoint
 * configured in .env. This is the implement-tests path; ping-llm.ts validates
 * the design-tests path.
 *
 * Run with:  npx tsx scripts/ping-codex.ts
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Codex, type ThreadEvent } from "@openai/codex-sdk";
import { loadRuntimeConfig } from "../src/config/runtimeConfig.js";
import { loadEnv } from "../src/shared/loadEnv.js";

loadEnv();

function envToStringRecord(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

async function main(): Promise<void> {
  const runtime = await loadRuntimeConfig();
  const llm = runtime.implementationLlm ?? runtime.llm;
  if (!llm) {
    console.error("No LLM picked up. Run ping-llm.ts first to debug .env.");
    process.exit(1);
  }
  if (llm.provider !== "openai") {
    console.error(
      `Codex SDK only runs with LLM_PROVIDER=openai. Current implementation provider: ${llm.provider}.`,
    );
    process.exit(1);
  }

  console.log("Resolved implementation LLM config:");
  console.log("  source:  ", runtime.implementationLlm ? "implementationLlm override" : "design llm fallback");
  console.log("  provider:", llm.provider);
  console.log("  model:   ", llm.model);
  console.log("  baseUrl: ", llm.baseUrl ?? "(default)");
  console.log("---");

  const workDir = await mkdtemp(join(tmpdir(), "manso-codex-ping-"));
  try {
    const codex = new Codex({
      apiKey: llm.apiKey,
      ...(llm.baseUrl ? { baseUrl: llm.baseUrl } : {}),
      env: envToStringRecord(process.env),
    });

    const thread = codex.startThread({
      workingDirectory: workDir,
      sandboxMode: "danger-full-access",
      approvalPolicy: "never",
      networkAccessEnabled: true,
      skipGitRepoCheck: true,
      ...(llm.model ? { model: llm.model } : {}),
    });

    console.log("Sending a trivial prompt to the Codex thread...");
    const started = Date.now();
    const streamedTurn = await thread.runStreamed(
      "Reply with the single word OK and then stop. Do not edit any files.",
    );

    const messages: string[] = [];
    let failure: string | undefined;
    for await (const event of streamedTurn.events as AsyncIterable<ThreadEvent>) {
      if (event.type === "turn.completed") {
        break;
      }
      if (event.type === "turn.failed") {
        failure = event.error.message;
        break;
      }
      if (event.type === "error") {
        failure = event.message;
        break;
      }
      collectEventOutput(event, messages);
    }

    const ms = Date.now() - started;
    if (failure) {
      console.error(`Codex turn failed after ${ms} ms:`);
      console.error(failure);
      process.exit(1);
    }

    console.log(`Codex turn completed in ${ms} ms.`);
    if (messages.length > 0) {
      console.log("---");
      console.log(messages.join("\n\n"));
    }
    console.log("---");
    console.log("Codex SDK is reachable against this endpoint + deployment.");
  } catch (error) {
    console.error("Codex SDK failed:");
    console.error(error instanceof Error ? error.message : String(error));
    if (error instanceof Error && error.cause) {
      console.error("Cause:", error.cause);
    }
    process.exit(1);
  } finally {
    await rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

function collectEventOutput(event: ThreadEvent, output: string[]): void {
  if (event.type !== "item.completed") {
    return;
  }
  if (event.item.type === "agent_message" && event.item.text.trim().length > 0) {
    output.push(event.item.text.trim());
    return;
  }
  if (event.item.type === "command_execution") {
    const commandOutput = [`$ ${event.item.command}`, event.item.aggregated_output.trim()].filter(Boolean).join("\n");
    if (commandOutput.trim().length > 0) {
      output.push(commandOutput);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
