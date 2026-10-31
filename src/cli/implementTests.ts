import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { runHealer } from "../agents/healer/index.js";
import { runImplementer } from "../agents/implementer/index.js";
import { runVerifier } from "../agents/verifier/index.js";
import {
  startEnvironment,
  stopEnvironment,
  type EnvironmentConfig,
  type EnvironmentContext,
  type EnvironmentStartResult,
} from "../agents/environment/index.js";
import { exploreBeforeImplement, type ExploreInput, type ExploreResult } from "../agents/explorer/index.js";
import { loadAgentConfig, type AgentConfig, type StackConfig } from "../config/agentConfig.js";
import { loadRuntimeConfig, type RuntimeConfig } from "../config/runtimeConfig.js";
import type { McpServers } from "../integrations/mcp/config.js";
import type { ObservabilityTelemetryConfig } from "../integrations/llm/types.js";
import {
  IMPLEMENTATION_SCHEMA_VERSION,
  ImplementationPackSchema,
  type CommandResult,
  type HealingAttempt,
  type ImplementationPack,
  type PullRequestReference,
} from "../domain/implementationPack/schema.js";
import { TestDesignPackSchema, type TestDesignPack } from "../domain/testDesignPack/schema.js";
import type { Warning } from "../domain/contextPack/schema.js";
import { AtlassianRestClient } from "../integrations/atlassianRest/client.js";
import { XrayCloudClient } from "../integrations/xray/client.js";
import { buildTestDesignFromXray } from "./implementFromXray.js";
import { commitChangesOnBranch, defaultBranchName, type GitPushAuth } from "../integrations/git/branchCommit.js";
import {
  resolveImplementationAgentRunners,
  type ImplementationAgentRunner,
} from "../integrations/llm/agentRunner.js";
import { resolveGitPushAuth, resolveVcsAdapter, vcsTokensFromRuntime } from "../integrations/vcs/resolve.js";
import type { VcsAdapter } from "../integrations/vcs/adapter.js";
import { checkBudget, sumUsageCost } from "../policy/budget.js";
import { appendRunCost, costLedgerPath, readDayCost } from "../policy/costLedger.js";
import { auditLogPath, emitAudit } from "../policy/auditLog.js";
import {
  writeImplementationPack,
  type WriteImplementationResult,
} from "../output/implementation/writer.js";
import { CliError } from "../shared/cli.js";
import type { CommandModule } from "./main.js";

const HELP = `manso implement-tests - implement automated tests in a repository.

Usage:
  manso implement-tests --repo <path> (--design <path> | --issue <KEY>) [options]

Options:
  --repo <path>       Target repository root. Required.
  --design <path>     Path to a TestDesignPack JSON (from design-tests).
  --issue <KEY>       Reconstruct the design from Xray instead of a file: fetch
                      the story's linked Cucumber tests, skip those already in
                      the repo, and implement the rest. Requires Jira + Xray
                      creds. Exactly one of --design / --issue is required.
  --stack <id>        Stack id to use. Defaults to the first configured stack.
  --out <dir>         Output directory for the ImplementationPack. Defaults to ./out.
  --verify <command>  Override the stack's verifyCommand.
  --no-verify         Skip the verification step (default: run it).
  --no-env            Skip the environment-aware path even if the stack
                      configures a setupCommand (don't spin up Docker).
  --require-linked-tests  With --issue: exit non-zero when the story has NO
                      linked Xray Cucumber tests (instead of a quiet no-op).
                      Recommended for the pipeline implement rule, where the
                      design step is expected to have run first.
  --max-heal-attempts Number of healing retries on verify failure. Default 1.
  --commit            Create a branch and commit any changes the agent made.
  --branch <name>     Branch name for --commit. Defaults to "manso/<KEY>".
  --target-branch <n> PR target branch. Defaults to "main".
  --push              After --commit, push the branch (--commit implied).
  --pr                Raise a pull request via the VCS adapter. Implies --commit + --push.
  --pr-title <t>      Override the PR title. Defaults to "Manso: implement <KEY>".
  --pr-description    Override the PR description (path to a markdown file).
  --pr-dry-run        Record what the PR raise would do, without calling the API.
  --dry-run           Skip the agent run; print what would happen.
  --config <path>     Optional JSON runtime-config file for non-secret overrides.
  -h, --help          Show this help.

The runner is picked from the runtime config (LLM_PROVIDER) — Claude Agent SDK
when "anthropic", Codex SDK when "openai". Set MANSO_IMPLEMENTATION_COMMAND
to use a custom shell command instead.

When the stack configures a setupCommand (e.g. \`docker compose up -d\`), the run
is environment-aware (M20): Manso brings the app up, explores it (Playwright
MCP for real UI locators, or OpenAPI for API endpoints) to ground the tests,
verifies against the live env, and tears it down. If Docker/the env is
unavailable it falls back to the normal flow and still raises the PR.

When verification fails, the Healer retries up to --max-heal-attempts times
with a narrow "fix the failing tests" prompt scoped to the failure. --pr detects
the remote from \`git remote get-url origin\` and uses the matching VCS adapter
(Azure DevOps or GitHub); set AZURE_DEVOPS_PAT or GITHUB_TOKEN accordingly.
`;

export interface CommitOptions {
  /** Branch name to create or check out. Defaults to `manso/<ISSUE-KEY>`. */
  branchName?: string;
  /** Push after committing. Required if you also want a PR raise. */
  push?: boolean;
  /** PR target branch. Recorded on the pack even when no PR is raised. */
  targetBranch?: string;
  /** Override the commit message (default: "Manso: implement <ISSUE-KEY>"). */
  commitMessage?: string;
  /** Author override for the commit. */
  author?: string;
  /**
   * Token-based `git push` auth for unattended runs. When omitted the push
   * uses the host's local git credentials.
   */
  pushAuth?: GitPushAuth;
}

export interface PullRequestOptions {
  /** VCS adapter (Azure DevOps in v1; GitHub later). */
  adapter: VcsAdapter;
  /** Branch the PR targets. Defaults to "main" if not set on `commit`. */
  targetBranch?: string;
  /** PR title. Defaults to "Manso: implement <ISSUE-KEY>". */
  title?: string;
  /** PR description / body. */
  description?: string;
  /** When true, do not call the platform API; record what would happen. */
  dryRun?: boolean;
}

export interface RunImplementTestsInput {
  testDesign: TestDesignPack;
  repoRoot: string;
  outDir: string;
  stack: StackConfig;
  runner: ImplementationAgentRunner;
  verifyCommand?: string;
  skipVerify?: boolean;
  dryRun?: boolean;
  /** Max healing retries on verify failure (M9b). Default 1. */
  maxHealAttempts?: number;
  /** When provided, create a branch + commit after the run. */
  commit?: CommitOptions;
  /** When provided, raise a PR after a successful commit + push. */
  pullRequest?: PullRequestOptions;
  /** MCP servers from `.agents/manso.config.json` to expose to the agent (M11). */
  mcpServers?: McpServers;
  /**
   * M20 environment-aware run: when set, Manso brings this environment up
   * (once), explores it to ground the tests, verifies against it, and tears it
   * down. When unset (or the env fails to start), it falls back to today's flow.
   */
  environment?: EnvironmentConfig;
  /** Agent runner used for the exploration pass (defaults to {@link runner}). */
  exploreRunner?: ImplementationAgentRunner;
  /** Injectable env/explore hooks (defaults to the real modules) — for tests. */
  envHooks?: EnvHooks;
  /** OTel telemetry config; when enabled, implement + heal agent runs are traced
   *  to Langfuse/Phoenix (session, token usage, cost). */
  telemetry?: ObservabilityTelemetryConfig;
}

/** Seam over the M20 environment + exploration modules, injectable for tests. */
export interface EnvHooks {
  start(config: EnvironmentConfig, ctx: EnvironmentContext): Promise<EnvironmentStartResult>;
  stop(config: EnvironmentConfig, ctx: EnvironmentContext): Promise<void>;
  explore(input: ExploreInput): Promise<ExploreResult>;
}

const defaultEnvHooks: EnvHooks = {
  start: startEnvironment,
  stop: stopEnvironment,
  explore: exploreBeforeImplement,
};

export interface RunImplementTestsOutput extends WriteImplementationResult {
  pack: ImplementationPack;
}

/**
 * Library-form `implement-tests`: Implementer → optional Verifier → writer.
 * The runner is injected so tests can stub it; the CLI builds it from
 * runtime config via {@link resolveImplementationAgentRunners}.
 */
export async function runImplementTests(input: RunImplementTestsInput): Promise<RunImplementTestsOutput> {
  const ticketKey = input.testDesign.ticket.key;
  const promptPath = join(input.outDir, sanitizePathSegment(ticketKey), "implementation.prompt.md");

  if (input.dryRun) {
    const dryPack = buildDryRunPack(input);
    const write = await writeImplementationPack(dryPack, input.outDir);
    return { ...write, pack: dryPack };
  }

  // M20: bring the environment up (once) and explore it before implementing,
  // when configured. Best-effort — a missing or failed environment never blocks
  // the run; Manso falls back to today's behaviour and still raises the PR.
  const envHooks = input.envHooks ?? defaultEnvHooks;
  const exploreRunner = input.exploreRunner ?? input.runner;
  const envCtx: EnvironmentContext = { repoRoot: input.repoRoot, onProgress: (m) => console.error(m) };
  const envWarnings: Warning[] = [];
  let envAttempted = false;
  let explorationBrief: string | undefined;

  if (input.environment) {
    envAttempted = true;
    const started = await envHooks.start(input.environment, envCtx);
    if (started.started) {
      const exploration = await envHooks.explore({
        stack: input.stack,
        testDesign: input.testDesign,
        repoRoot: input.repoRoot,
        ...(input.environment.appUrl ? { appUrl: input.environment.appUrl } : {}),
        ...(input.stack.openApiUrl ? { openApiUrl: input.stack.openApiUrl } : {}),
        runner: exploreRunner,
        ...(input.mcpServers ? { mcpServers: input.mcpServers } : {}),
        onProgress: (m) => console.error(m),
      });
      envWarnings.push(...exploration.warnings);
      if (exploration.brief) {
        explorationBrief = exploration.brief;
        await writeExplorationBrief(input.outDir, ticketKey, exploration.brief);
        console.error(`Exploration: captured a ${exploration.modality} brief for ${ticketKey}.`);
      }
    } else {
      console.error(`Environment not ready (${started.message}); continuing without live exploration/verify.`);
      envWarnings.push({ section: "environment", toolName: "docker", message: started.message });
    }
  }

  try {
  const implementer = await runImplementer({
    testDesign: input.testDesign,
    repoRoot: input.repoRoot,
    stack: input.stack,
    runner: input.runner,
    promptPath,
    ...(input.mcpServers ? { mcpServers: input.mcpServers } : {}),
    ...(explorationBrief ? { explorationBrief } : {}),
    ...(input.telemetry ? { telemetry: input.telemetry } : {}),
  });

  let changedFiles = implementer.changedFiles;
  const verifyCommand = input.verifyCommand ?? input.stack.verifyCommand;
  let verification: CommandResult | undefined;
  if (!input.skipVerify) {
    verification = await runVerifier({
      command: verifyCommand,
      repoRoot: input.repoRoot,
    });
  }

  const healingAttempts: HealingAttempt[] = [];
  const maxHealAttempts = input.maxHealAttempts ?? 1;
  if (
    verification &&
    verification.exitCode !== 0 &&
    implementer.status !== "failed" &&
    maxHealAttempts > 0
  ) {
    for (let attempt = 1; attempt <= maxHealAttempts; attempt += 1) {
      const heal = await runHealer({
        issueKey: ticketKey,
        repoRoot: input.repoRoot,
        runner: input.runner,
        previousVerification: verification,
        previousChangedFiles: changedFiles,
        verifyCommand,
        attempt,
        maxAttempts: maxHealAttempts,
        ...(implementer.promptPath ? { originalPromptPath: implementer.promptPath } : {}),
        ...(input.mcpServers ? { mcpServers: input.mcpServers } : {}),
        ...(input.telemetry ? { telemetry: input.telemetry } : {}),
      });
      healingAttempts.push(heal.attempt);
      changedFiles = heal.changedFiles;
      verification = heal.attempt.verification;
      if (verification.exitCode === 0) {
        break;
      }
    }
  }

  const commitResult = input.commit
    ? await commitChangesOnBranch({
        repoRoot: input.repoRoot,
        branchName: input.commit.branchName ?? defaultBranchName(ticketKey),
        commitMessage: input.commit.commitMessage ?? `Manso: implement ${ticketKey}`,
        ...(input.commit.push ? { push: true } : {}),
        ...(input.commit.pushAuth ? { pushAuth: input.commit.pushAuth } : {}),
        ...(input.commit.author ? { author: input.commit.author } : {}),
      })
    : undefined;

  let pullRequest: PullRequestReference | undefined;
  if (input.pullRequest && commitResult) {
    const targetBranch = input.pullRequest.targetBranch ?? input.commit?.targetBranch ?? "main";
    if (!commitResult.committed) {
      pullRequest = {
        branch: commitResult.branch,
        targetBranch,
        status: "skipped",
        message: "Nothing to commit; PR not raised.",
      };
    } else if (!commitResult.pushed && !input.pullRequest.dryRun) {
      pullRequest = {
        branch: commitResult.branch,
        targetBranch,
        status: "skipped",
        message: "Branch was not pushed; run with --push to enable PR raise.",
      };
    } else {
      const raise = await input.pullRequest.adapter.raisePullRequest({
        branch: commitResult.branch,
        targetBranch,
        title: input.pullRequest.title ?? `Manso: implement ${ticketKey}`,
        ...(input.pullRequest.description ? { description: input.pullRequest.description } : {}),
        ...(input.pullRequest.dryRun ? { dryRun: true } : {}),
      });
      pullRequest = {
        branch: commitResult.branch,
        targetBranch,
        status: raise.status,
        ...(raise.url ? { url: raise.url } : {}),
        ...(raise.pullRequestId !== undefined ? { pullRequestId: raise.pullRequestId } : {}),
        ...(raise.message ? { message: raise.message } : {}),
      };
    }
  }

  const finalStatus = deriveFinalStatus(implementer.status, verification, changedFiles.length);
  const rescuedFromAgentFailure = implementer.status === "failed" && finalStatus !== "failed";

  const pack: ImplementationPack = {
    schemaVersion: IMPLEMENTATION_SCHEMA_VERSION,
    ticket: { key: ticketKey, title: input.testDesign.ticket.title },
    stack: input.stack.id,
    repoRoot: input.repoRoot,
    ...(commitResult ? { branch: commitResult.branch } : {}),
    ...(input.commit?.targetBranch ? { targetBranch: input.commit.targetBranch } : {}),
    status: finalStatus,
    implementation: implementer.implementation,
    ...(verification ? { verification } : {}),
    healingAttempts,
    changedFiles,
    scenarios: implementer.scenarios,
    ...(pullRequest ? { pullRequest } : {}),
    ...(implementer.promptPath ? { promptPath: implementer.promptPath } : {}),
    provenance: {
      generatedAt: new Date().toISOString(),
      issueKey: ticketKey,
      llm: {
        provider: input.runner.provider ?? "anthropic",
        ...(input.runner.model ? { model: input.runner.model } : {}),
      },
      tools: [],
    },
    warnings: [
      ...envWarnings,
      ...(rescuedFromAgentFailure
        ? [{
            section: "implementation",
            toolName: "agent",
            message: `The implementation agent exited non-zero (${(implementer.implementation.stderr ?? "no stderr").slice(0, 200)}), but verify passed with ${changedFiles.length} changed file(s) — proceeding as "partial" for human review instead of discarding the work.`,
          }]
        : []),
      ...(commitResult
        ? commitResult.warnings.map((message) => ({ section: "commit", toolName: "git", message }))
        : []),
    ],
  };

  const validated = ImplementationPackSchema.parse(pack);
  const write = await writeImplementationPack(validated, input.outDir);
  return { ...write, pack: validated };
  } finally {
    if (envAttempted && input.environment) {
      await envHooks.stop(input.environment, envCtx);
    }
  }
}

function deriveFinalStatus(
  implementerStatus: ImplementationPack["status"],
  verification: CommandResult | undefined,
  changedFilesCount: number,
): ImplementationPack["status"] {
  if (implementerStatus === "failed") {
    // Rescue: the agent exited non-zero (e.g. a transport drop at the end of
    // its turn) but left verified work behind. Reporting "failed" would turn
    // the run red and bury a green implementation — downgrade to "partial" so
    // the commit/PR proceeds and a human reviews it.
    if (verification && verification.exitCode === 0 && changedFilesCount > 0) return "partial";
    return "failed";
  }
  if (verification && verification.exitCode !== 0) return "partial";
  return implementerStatus;
}

function buildDryRunPack(input: RunImplementTestsInput): ImplementationPack {
  const pack: ImplementationPack = {
    schemaVersion: IMPLEMENTATION_SCHEMA_VERSION,
    ticket: { key: input.testDesign.ticket.key, title: input.testDesign.ticket.title },
    stack: input.stack.id,
    repoRoot: input.repoRoot,
    status: "dry-run",
    implementation: {
      command: input.runner.commandLabel,
      exitCode: 0,
      durationMs: 0,
      stdout: "dry-run: agent was not invoked.",
    },
    healingAttempts: [],
    changedFiles: [],
    scenarios: input.testDesign.scenarios.map((scenario, index) => ({
      scenarioIndex: index,
      title: scenario.title,
      acIds: scenario.acIds,
      status: "skipped" as const,
      reason: "dry-run",
    })),
    provenance: {
      generatedAt: new Date().toISOString(),
      issueKey: input.testDesign.ticket.key,
      llm: {
        provider: input.runner.provider ?? "anthropic",
        ...(input.runner.model ? { model: input.runner.model } : {}),
      },
      tools: [],
    },
    warnings: [],
  };
  return ImplementationPackSchema.parse(pack);
}

async function run(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      repo: { type: "string" },
      design: { type: "string" },
      issue: { type: "string" },
      stack: { type: "string" },
      out: { type: "string" },
      verify: { type: "string" },
      "no-verify": { type: "boolean" },
      "no-env": { type: "boolean" },
      "require-linked-tests": { type: "boolean" },
      "max-heal-attempts": { type: "string" },
      commit: { type: "boolean" },
      branch: { type: "string" },
      "target-branch": { type: "string" },
      push: { type: "boolean" },
      pr: { type: "boolean" },
      "pr-title": { type: "string" },
      "pr-description": { type: "string" },
      "pr-dry-run": { type: "boolean" },
      "dry-run": { type: "boolean" },
      config: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(HELP);
    return 0;
  }

  if (!values.repo) {
    throw new CliError("--repo is required. Run 'manso implement-tests --help' for usage.");
  }
  const hasDesign = Boolean(values.design);
  const hasIssue = Boolean(values.issue);
  if (hasDesign === hasIssue) {
    throw new CliError(
      "Provide exactly one of --design <path> or --issue <KEY>. Use --design for a local TestDesignPack, or --issue to reconstruct it from the story's linked Xray tests.",
    );
  }

  const repoRoot = resolve(values.repo);
  const outDir = resolve(values.out ?? "./out");
  const dryRun = values["dry-run"] ?? false;
  const skipVerify = values["no-verify"] ?? false;
  const maxHealAttempts = parseHealAttempts(values["max-heal-attempts"]);
  const wantPr = values.pr ?? false;
  // --pr implies --commit + --push for the underlying flow.
  const shouldCommit = (values.commit ?? false) || (values.push ?? false) || wantPr;
  const shouldPush = (values.push ?? false) || wantPr;
  const commitOptions: CommitOptions | undefined = shouldCommit
    ? {
        ...(values.branch ? { branchName: values.branch } : {}),
        ...(shouldPush ? { push: true } : {}),
        ...(values["target-branch"] ? { targetBranch: values["target-branch"] } : {}),
      }
    : undefined;

  const runtime = await loadRuntimeConfig(values.config ? { configPath: values.config } : {});

  // Token-based push auth for unattended (pipeline) runs. Falls back to the
  // host's local git credentials when no matching token is configured.
  if (shouldPush && commitOptions) {
    const pushAuth = await resolveGitPushAuth(repoRoot, vcsTokensFromRuntime(runtime));
    if (pushAuth) {
      commitOptions.pushAuth = pushAuth;
      console.error(`Push auth: ${pushAuth.description}.`);
    } else {
      console.error("Push auth: no VCS token configured — using local git credentials.");
    }
  }

  // Resolve the TestDesignPack: from a local file (--design) or reconstructed
  // from the story's linked Xray tests (--issue). The latter makes the implement
  // step stateless for a standalone pipeline job.
  let testDesign: TestDesignPack;
  if (hasDesign) {
    testDesign = await loadTestDesignFromDisk(resolve(values.design!));
  } else {
    const { jira, xray } = buildXrayClients(runtime);
    const built = await buildTestDesignFromXray({
      ticketKey: values.issue!,
      repoRoot,
      jira,
      xray,
      onProgress: (message) => console.error(message),
    });
    if (built.kind === "nothing-to-do") {
      const s = built.summary;
      console.log(
        `Nothing to implement for ${s.ticketKey}: ${s.linkedTests} linked Cucumber test(s), ${s.alreadyImplemented} already in the repo, ${s.parseFailures} unparseable.`,
      );
      for (const warning of s.warnings) console.warn(`! ${warning.message}`);
      if (s.linkedTests === 0) {
        // Zero linked tests usually means the design step never ran (or the
        // tests were deleted) — make the no-op loud instead of a quiet green.
        const message = `${s.ticketKey} has no linked Xray Cucumber tests — did the design step run? This implement run did nothing.`;
        if (values["require-linked-tests"]) {
          throw new CliError(message);
        }
        console.warn(`WARNING: ${message} (pass --require-linked-tests to fail instead)`);
      }
      return 0;
    }
    for (const warning of built.summary.warnings) console.warn(`! ${warning.message}`);
    console.error(
      `Xray-sourced design for ${built.summary.ticketKey}: implementing ${built.summary.toImplement} of ${built.summary.linkedTests} linked test(s) (${built.summary.alreadyImplemented} already in repo).`,
    );
    testDesign = built.pack;
  }
  const ticketKey = testDesign.ticket.key;
  const agentConfig = await loadAgentConfig(repoRoot);
  const stack = pickStackFromConfig(agentConfig, repoRoot, values.stack);
  const mcpServers = agentConfig.mcpServers;
  const runner = pickRunner(runtime);

  // M20: env-aware run when the stack configures a setupCommand (and --no-env
  // wasn't passed). When the env can't start, the run falls back gracefully.
  let environment: EnvironmentConfig | undefined;
  if (stack.setupCommand && !(values["no-env"] ?? false) && !dryRun) {
    const readyUrl = stack.healthCheck ?? stack.appUrl;
    environment = {
      setupCommand: stack.setupCommand,
      ...(stack.teardownCommand ? { teardownCommand: stack.teardownCommand } : {}),
      ...(stack.appUrl ? { appUrl: stack.appUrl } : {}),
      ...(readyUrl ? { readyUrl } : {}),
      ...(stack.readinessTimeoutMs ? { timeoutMs: stack.readinessTimeoutMs } : {}),
    };
    console.error(`Environment-aware: will set up via \`${stack.setupCommand}\`, explore, and verify against the live app.`);
  }
  if (Object.keys(mcpServers).length > 0) {
    console.error(`MCP: ${Object.keys(mcpServers).join(", ")} available to the agent.`);
  }

  // Governance: cost ledger + audit log live under the run's out dir.
  const budget = agentConfig.policy.budgets;
  const redactPatterns = agentConfig.policy.redactPatterns;
  const ledgerPath = costLedgerPath(outDir);
  const auditPath = auditLogPath(outDir);
  await emitAudit({ path: auditPath, action: "run.started", actor: "implement-tests", target: ticketKey, detail: { stack: stack.id }, redactPatterns });

  // M15: refuse to start when today's recorded spend already exceeds the cap.
  if (!dryRun && budget.maxCostPerDayUsd !== undefined) {
    const dayCost = await readDayCost(ledgerPath);
    const decision = checkBudget({ budget, runCostUsd: 0, dayCostUsd: dayCost });
    if (!decision.ok) {
      await emitAudit({ path: auditPath, action: "budget.breached", actor: "implement-tests", target: ticketKey, detail: { scope: "day", message: decision.message }, redactPatterns });
      throw new CliError(`Daily cost budget already reached: ${decision.message}. Raise policy.budgets.maxCostPerDayUsd or wait for the next day.`);
    }
  }

  // policy.gates.humanReviewBeforePr: when true, prepare the branch (commit +
  // push) but do not raise the PR — a human opens it after review.
  const humanReviewBeforePr = agentConfig.policy.gates.humanReviewBeforePr;
  let pullRequestOptions: PullRequestOptions | undefined;
  if (wantPr) {
    if (humanReviewBeforePr && !(values["pr-dry-run"] ?? false) && !dryRun) {
      console.error(
        "Gate humanReviewBeforePr=true: will commit + push the branch but NOT raise the PR. Open it manually, or set policy.gates.humanReviewBeforePr=false to auto-raise.",
      );
    }
    pullRequestOptions = await buildPullRequestOptions(repoRoot, runtime, values, dryRun || humanReviewBeforePr);
  }

  console.error(`Implementer: runner=${runner.kind}${runner.model ? ` model=${runner.model}` : ""}`);
  if (dryRun) {
    console.error("Dry run: agent will not be invoked.");
  }

  const result = await runImplementTests({
    testDesign,
    repoRoot,
    outDir,
    stack,
    runner,
    dryRun,
    skipVerify,
    maxHealAttempts,
    ...(values.verify ? { verifyCommand: values.verify } : {}),
    ...(commitOptions ? { commit: commitOptions } : {}),
    ...(pullRequestOptions ? { pullRequest: pullRequestOptions } : {}),
    ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
    ...(environment ? { environment } : {}),
    ...(runtime.observability?.telemetry ? { telemetry: runtime.observability.telemetry } : {}),
  });

  // M15: record the run's measured agent cost and warn on a run/day breach.
  if (!dryRun) {
    const runCostUsd = sumUsageCost([
      result.pack.implementation.usage,
      ...result.pack.healingAttempts.map((heal) => heal.agent.usage),
    ]);
    if (runCostUsd > 0) {
      try {
        await appendRunCost(ledgerPath, { runCostUsd, issueKey: ticketKey, command: "implement-tests" });
      } catch {
        /* ledger write is best-effort */
      }
    }
    const dayCost = await readDayCost(ledgerPath);
    const decision = checkBudget({ budget, runCostUsd, dayCostUsd: dayCost });
    if (!decision.ok) {
      console.warn(`! Cost budget exceeded: ${decision.message}`);
      await emitAudit({ path: auditPath, action: "budget.breached", actor: "implement-tests", target: ticketKey, detail: { message: decision.message, runCostUsd, dayCostUsd: dayCost }, redactPatterns });
    } else if (runCostUsd > 0) {
      console.error(`Cost: $${runCostUsd.toFixed(2)} this run · $${dayCost.toFixed(2)} today.`);
    }
  }

  // M16: audit the PR raise + run completion.
  const pr = result.pack.pullRequest;
  if (pr && (pr.status === "raised" || pr.status === "exists")) {
    await emitAudit({ path: auditPath, action: "pr.raised", actor: "implement-tests", target: ticketKey, detail: { status: pr.status, ...(pr.url ? { url: pr.url } : {}), branch: pr.branch }, redactPatterns });
  }
  await emitAudit({ path: auditPath, action: "run.completed", actor: "implement-tests", target: ticketKey, detail: { status: result.pack.status, changedFiles: result.pack.changedFiles.length }, redactPatterns });

  console.log(`Wrote ${result.jsonPath}`);
  console.log(`Wrote ${result.markdownPath}`);
  console.log(
    `Status: ${result.pack.status}  ·  changed files: ${result.pack.changedFiles.length}  ·  scenarios: ${result.pack.scenarios.length}`,
  );
  if (result.pack.verification) {
    console.log(`Verify exit: ${result.pack.verification.exitCode} (${result.pack.verification.durationMs} ms)`);
  }
  if (result.pack.healingAttempts.length > 0) {
    const passed = result.pack.healingAttempts.filter((attempt) => attempt.verification.exitCode === 0).length;
    console.log(`Heal attempts: ${result.pack.healingAttempts.length} (${passed} green)`);
  }
  if (result.pack.branch) {
    console.log(`Committed on branch: ${result.pack.branch}`);
  }
  if (result.pack.pullRequest) {
    const pr = result.pack.pullRequest;
    console.log(`Pull request: ${pr.status}${pr.url ? ` — ${pr.url}` : ""}`);
    if (pr.message) {
      console.log(`  ${pr.message}`);
    }
  }
  return result.pack.status === "failed" ? 1 : 0;
}

async function buildPullRequestOptions(
  repoRoot: string,
  runtime: RuntimeConfig,
  values: Record<string, string | boolean | undefined>,
  globalDryRun: boolean,
): Promise<PullRequestOptions> {
  const resolution = await resolveVcsAdapter(repoRoot, vcsTokensFromRuntime(runtime));
  if (!resolution.ok) {
    throw new CliError(`--pr: ${resolution.reason}`);
  }
  const adapter = resolution.adapter;

  const titleOverride = typeof values["pr-title"] === "string" ? values["pr-title"] : undefined;
  const descriptionOverride =
    typeof values["pr-description"] === "string" ? values["pr-description"] : undefined;
  const description = descriptionOverride
    ? await readDescriptionFile(descriptionOverride)
    : undefined;
  const prDryRun = Boolean(values["pr-dry-run"]) || globalDryRun;

  return {
    adapter,
    ...(titleOverride ? { title: titleOverride } : {}),
    ...(description ? { description } : {}),
    ...(prDryRun ? { dryRun: true } : {}),
  };
}

async function readDescriptionFile(path: string): Promise<string> {
  try {
    return await readFile(resolve(path), "utf8");
  } catch (error) {
    throw new CliError(
      `Could not read --pr-description file at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Write the M20 exploration brief to out/<KEY>/exploration.md. */
async function writeExplorationBrief(outDir: string, ticketKey: string, brief: string): Promise<void> {
  const dir = join(outDir, sanitizePathSegment(ticketKey));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "exploration.md"), brief.endsWith("\n") ? brief : `${brief}\n`, "utf8");
}

/** Build Jira + Xray clients for the `--issue` (Xray-sourced) path. */
function buildXrayClients(runtime: RuntimeConfig): { jira: AtlassianRestClient; xray: XrayCloudClient } {
  if (!runtime.jiraRest) {
    throw new CliError(
      "--issue needs Jira credentials (JIRA_URL / JIRA_USERNAME / JIRA_API_TOKEN) to read the story's linked tests.",
    );
  }
  if (!runtime.xray) {
    throw new CliError(
      "--issue needs Xray credentials (XRAY_CLIENT_ID / XRAY_CLIENT_SECRET) to fetch the linked tests' Gherkin.",
    );
  }
  const jira = new AtlassianRestClient({
    jira: {
      baseUrl: runtime.jiraRest.jiraUrl,
      username: runtime.jiraRest.jiraUsername,
      apiToken: runtime.jiraRest.jiraApiToken,
    },
  });
  const xray = new XrayCloudClient({
    baseUrl: runtime.xray.baseUrl,
    clientId: runtime.xray.clientId,
    clientSecret: runtime.xray.clientSecret,
  });
  return { jira, xray };
}

async function loadTestDesignFromDisk(path: string): Promise<TestDesignPack> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new CliError(`Could not read TestDesignPack at ${path}.`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new CliError(`Invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = TestDesignPackSchema.safeParse(json);
  if (!parsed.success) {
    throw new CliError(
      `TestDesignPack at ${path} does not validate. Issues:\n${parsed.error.issues.map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`).join("\n")}`,
    );
  }
  return parsed.data;
}

function pickStackFromConfig(config: AgentConfig, repoRoot: string, requestedId?: string): StackConfig {
  if (config.stacks.length === 0) {
    throw new CliError(
      `No stacks configured in ${repoRoot}/.agents/manso.config.json. Add a stack and re-run.`,
    );
  }
  if (requestedId) {
    const stack = config.stacks.find((candidate) => candidate.id === requestedId);
    if (!stack) {
      throw new CliError(
        `--stack "${requestedId}" is not configured. Available: ${config.stacks.map((s) => s.id).join(", ")}`,
      );
    }
    return stack;
  }
  const first = config.stacks[0];
  if (!first) {
    throw new CliError(`No stacks configured in ${repoRoot}.`);
  }
  return first;
}

function pickRunner(runtime: RuntimeConfig): ImplementationAgentRunner {
  const { implementation } = resolveImplementationAgentRunners({}, runtime);
  return implementation;
}

function parseHealAttempts(value: string | undefined): number {
  if (value === undefined) return 1;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new CliError(`--max-heal-attempts must be a non-negative integer; got "${value}".`);
  }
  return parsed;
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
}

const command: CommandModule = { run };
export default command;
