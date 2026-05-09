import { Buffer } from "node:buffer";
import type { ToolProvenance, Warning } from "../../domain/contextPack/schema.js";
import {
  XRAY_TEST_IMPLEMENTATION_SCHEMA_VERSION,
  XrayTestImplementationPackSchema,
} from "../../domain/xrayTestImplementation/schema.js";
import type {
  XrayTestImplementationCommandResult,
  XrayTestImplementationGuidanceFile,
  XrayTestImplementationHealingAttempt,
  XrayTestImplementationPack,
  XrayTestImplementationPullRequest,
} from "../../domain/xrayTestImplementation/schema.js";
import type { XrayTestGenerationPack } from "../../domain/xrayTestGeneration/schema.js";
import { writeXrayTestImplementationPack } from "../../output/xray-test-implementation/writer.js";
import type { XrayTestImplementationGuidanceContent } from "./prompt.js";

export interface BuildPackInput {
  generation: XrayTestGenerationPack;
  xrayTestGenerationPath: string;
  repoRoot: string;
  branch: string;
  targetBranch: string;
  promptPath: string;
  guidanceFiles: XrayTestImplementationGuidanceContent[];
  status: "prompt-only" | "completed" | "failed";
  command?: XrayTestImplementationCommandResult;
  verification?: XrayTestImplementationCommandResult;
  healingAttempts?: XrayTestImplementationHealingAttempt[];
  changedFiles: string[];
  commitSha?: string;
  pushed: boolean;
  pullRequest: XrayTestImplementationPullRequest;
  tools: ToolProvenance[];
  warnings: Warning[];
}

export function buildXrayTestImplementationPack(input: BuildPackInput): XrayTestImplementationPack {
  const guidanceFiles: XrayTestImplementationGuidanceFile[] = input.guidanceFiles.map((file) => ({
    path: file.path,
    bytes: Buffer.byteLength(file.content, "utf8"),
  }));
  const pack: XrayTestImplementationPack = {
    schemaVersion: XRAY_TEST_IMPLEMENTATION_SCHEMA_VERSION,
    ticket: {
      key: input.generation.ticket.key,
      title: input.generation.ticket.title,
      ...(input.generation.ticket.url ? { url: input.generation.ticket.url } : {}),
    },
    implementation: {
      status: input.status,
      repoRoot: input.repoRoot,
      branch: input.branch,
      targetBranch: input.targetBranch,
      promptPath: input.promptPath,
      guidanceFiles,
      ...(input.command ? { command: input.command } : {}),
      ...(input.verification ? { verification: input.verification } : {}),
      ...(input.healingAttempts && input.healingAttempts.length > 0 ? { healingAttempts: input.healingAttempts } : {}),
      changedFiles: input.changedFiles,
      ...(input.commitSha ? { commitSha: input.commitSha } : {}),
      pushed: input.pushed,
    },
    pullRequest: input.pullRequest,
    provenance: {
      generatedAt: new Date().toISOString(),
      sourceXrayTestGenerationPath: input.xrayTestGenerationPath,
      tools: input.tools,
    },
    warnings: input.warnings,
  };

  return XrayTestImplementationPackSchema.parse(pack);
}

export interface WriteFailedImplementationPackOptions {
  generation: XrayTestGenerationPack;
  xrayTestGenerationPath: string;
  repoRoot: string;
  branch: string;
  targetBranch: string;
  promptPath: string;
  guidanceFiles: XrayTestImplementationGuidanceContent[];
  implementationCommand: XrayTestImplementationCommandResult;
  verification: XrayTestImplementationCommandResult;
  healingAttempts: XrayTestImplementationHealingAttempt[];
  changedFiles: string[];
  tools: ToolProvenance[];
  warnings: Warning[];
  outputDir: string;
  message: string;
}

export async function writeFailedImplementationPack(options: WriteFailedImplementationPackOptions): Promise<void> {
  const pack = buildXrayTestImplementationPack({
    generation: options.generation,
    xrayTestGenerationPath: options.xrayTestGenerationPath,
    repoRoot: options.repoRoot,
    branch: options.branch,
    targetBranch: options.targetBranch,
    promptPath: options.promptPath,
    guidanceFiles: options.guidanceFiles,
    status: "failed",
    command: options.implementationCommand,
    verification: options.verification,
    ...(options.healingAttempts.length > 0 ? { healingAttempts: options.healingAttempts } : {}),
    changedFiles: options.changedFiles,
    pushed: false,
    pullRequest: {
      status: "skipped",
      warnings: [options.message],
    },
    tools: options.tools,
    warnings: [
      ...options.warnings,
      {
        section: "verification",
        toolName: "shell:verify-command",
        message: options.message,
      },
    ],
  });
  const result = await writeXrayTestImplementationPack(pack, options.outputDir);
  console.log(`Wrote ${result.jsonPath}`);
  console.log(`Wrote ${result.markdownPath}`);
}
