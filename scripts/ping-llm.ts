#!/usr/bin/env node
/**
 * Verify the LLM provider configured in .env is reachable and returns text.
 * Run with:  npx tsx scripts/ping-llm.ts
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadRuntimeConfig } from "../src/config/runtimeConfig.js";
import { createLlmTextClient } from "../src/integrations/llm/factory.js";
import { loadEnv } from "../src/shared/loadEnv.js";

loadEnv();

function preview(value: string | undefined, len = 8): string {
  if (!value) return "(unset)";
  if (value.length <= len) return `${value} (len=${value.length})`;
  return `${value.slice(0, len)}… (len=${value.length})`;
}

function printDiagnostics(): void {
  console.log("Working directory:", process.cwd());
  console.log(".env present here:", existsSync(resolve(process.cwd(), ".env")));
  console.log("---");
  console.log("Env vars visible to Node:");
  console.log("  LLM_PROVIDER     =", process.env.LLM_PROVIDER ?? "(unset)");
  console.log("  LLM_API_KEY      =", preview(process.env.LLM_API_KEY));
  console.log("  LLM_MODEL        =", process.env.LLM_MODEL ?? "(unset)");
  console.log("  LLM_BASE_URL     =", process.env.LLM_BASE_URL ?? "(unset)");
  console.log("  ANTHROPIC_API_KEY=", preview(process.env.ANTHROPIC_API_KEY));
  console.log("  OPENAI_API_KEY   =", preview(process.env.OPENAI_API_KEY));
  console.log("---");
}

async function main(): Promise<void> {
  printDiagnostics();

  const runtime = await loadRuntimeConfig();
  if (!runtime.llm) {
    console.error(
      [
        "No LLM picked up. Common causes:",
        "  - LLM_PROVIDER not 'openai' or 'anthropic'",
        "  - LLM_API_KEY (or OPENAI_API_KEY / ANTHROPIC_API_KEY) is empty",
        "  - You ran this from a different directory than manso-claude/",
        "  - .env line has trailing whitespace or stray quotes",
      ].join("\n"),
    );
    process.exit(1);
  }

  console.log("Resolved LLM config:");
  console.log("  provider:", runtime.llm.provider);
  console.log("  model:   ", runtime.llm.model);
  console.log("  baseUrl: ", runtime.llm.baseUrl ?? "(default)");
  console.log("---");

  const llm = createLlmTextClient(runtime.llm);
  const started = Date.now();
  try {
    const text = await llm.generateText({
      systemPrompt: "You are concise. Answer in fewer than 10 words.",
      userPrompt: "Reply with the single word OK and nothing else.",
      operation: "ping",
    });
    console.log(`Response in ${Date.now() - started} ms:`);
    console.log(text);
    console.log("---");
    console.log("LLM is reachable.");
  } catch (error) {
    console.error(`LLM call failed after ${Date.now() - started} ms:`);
    console.error(error instanceof Error ? error.message : String(error));
    if (error instanceof Error && error.cause) {
      console.error("Cause:", error.cause);
    }
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
