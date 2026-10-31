import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { runRespondToPr, type RespondToPrResult } from "../agents/responder/index.js";
import { loadAgentConfig } from "../config/agentConfig.js";
import { loadRuntimeConfig, type RuntimeConfig } from "../config/runtimeConfig.js";
import { resolveImplementationAgentRunners } from "../integrations/llm/agentRunner.js";
import { resolveGitPushAuth, resolveVcsAdapter, vcsTokensFromRuntime } from "../integrations/vcs/resolve.js";
import type { VcsAdapter } from "../integrations/vcs/adapter.js";
import type { GitPushAuth } from "../integrations/git/branchCommit.js";
import { auditLogPath, emitAudit } from "../policy/auditLog.js";
import { CliError } from "../shared/cli.js";
import type { CommandModule } from "./main.js";

const HELP = `manso respond-to-pr - respond to @manso PR comments.

Usage:
  manso respond-to-pr --repo <path> --pr <id> --issue <KEY> [options]

Options:
  --repo <path>       Target repository root. Required.
  --pr <id>           Pull request id. Required.
  --issue <KEY>       Jira issue key the PR implements. Required.
  --stack <id>        Stack id (for the verify command). Defaults to the first.
  --verify <command>  Override the verify command run after a fix.
  --mention <handle>  Mention handle to listen for. Defaults to .agents pr.mention.
  --max-iterations    Override the PR-wide responder iteration budget.
  --dry-run           Classify + report only; do not edit, verify, or post.
  --config <path>     Optional JSON runtime-config file for non-secret overrides.
  -h, --help          Show this help.

Reads the PR's comment threads, finds the latest unanswered comment that
addresses @manso, classifies its intent, and either applies a small,
feedback-scoped fix (re-verifying and replying with the result) or posts a
reply. Loop-safety: it never answers its own comments, skips already-answered
threads, and stops at the iteration budget (.agents pr.maxIterationsPerPr).

Knowledge-update triggers (always proposed via a separate review PR, never
applied silently):
  @update-knowledge <rule>  Propose a rule for THIS repo's .agents/guidelines/.
  @update-agent <rule>      Propose a general rule for Manso's own repo
                            (requires MANSO_AGENT_REPO = a local checkout).

Requires a supported remote (Azure DevOps or GitHub) and its token
(AZURE_DEVOPS_PAT or GITHUB_TOKEN); the adapter is chosen from the remote.
`;

async function run(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      repo: { type: "string" },
      pr: { type: "string" },
      issue: { type: "string" },
      stack: { type: "string" },
      verify: { type: "string" },
      mention: { type: "string" },
      "max-iterations": { type: "string" },
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

  if (!values.repo) throw new CliError("--repo is required. Run 'manso respond-to-pr --help' for usage.");
  if (!values.pr) throw new CliError("--pr is required (the pull request id).");
  if (!values.issue) throw new CliError("--issue is required (the Jira issue key the PR implements).");

  const pullRequestId = Number.parseInt(values.pr, 10);
  if (!Number.isFinite(pullRequestId) || pullRequestId <= 0) {
    throw new CliError(`--pr must be a positive integer; got "${values.pr}".`);
  }

  const repoRoot = resolve(values.repo);
  const dryRun = values["dry-run"] ?? false;
  const runtime = await loadRuntimeConfig(values.config ? { configPath: values.config } : {});
  const agentConfig = await loadAgentConfig(repoRoot);

  const stack = values.stack
    ? agentConfig.stacks.find((candidate) => candidate.id === values.stack)
    : agentConfig.stacks[0];
  if (values.stack && !stack) {
    throw new CliError(`--stack "${values.stack}" is not configured. Available: ${agentConfig.stacks.map((s) => s.id).join(", ")}`);
  }
  const verifyCommand = values.verify ?? stack?.verifyCommand;
  if (!verifyCommand) {
    throw new CliError("No verify command available. Pass --verify or configure a stack with verifyCommand.");
  }

  const resolution = await resolveVcsAdapter(repoRoot, vcsTokensFromRuntime(runtime));
  if (!resolution.ok) {
    throw new CliError(`respond-to-pr: ${resolution.reason}`);
  }
  const adapter = resolution.adapter;

  const { implementation: runner } = resolveImplementationAgentRunners({}, runtime);
  const mention = values.mention ?? agentConfig.pr.mention;
  const maxIterations = values["max-iterations"] !== undefined
    ? Number.parseInt(values["max-iterations"], 10)
    : agentConfig.pr.maxIterationsPerPr;

  // @update-agent target: a local Manso checkout pointed to by
  // MANSO_AGENT_REPO, with its own (Azure or GitHub) adapter.
  const { agentRepoRoot, agentAdapter, agentPushAuth } = await resolveAgentRepo(runtime);

  // Token-based push auth for proposal PRs (else local git credentials).
  const pushAuth = await resolveGitPushAuth(repoRoot, vcsTokensFromRuntime(runtime));

  console.error(`Responder: PR ${pullRequestId} in ${resolution.description} (${resolution.kind}), listening for "${mention}".`);
  if (dryRun) console.error("Dry run: will classify + report only.");

  const result = await runRespondToPr({
    issueKey: values.issue,
    repoRoot,
    pullRequestId,
    adapter,
    runner,
    verifyCommand,
    mention,
    maxIterations,
    ...(agentConfig.mcpServers && Object.keys(agentConfig.mcpServers).length > 0 ? { mcpServers: agentConfig.mcpServers } : {}),
    ...(agentRepoRoot ? { agentRepoRoot } : {}),
    ...(agentAdapter ? { agentAdapter } : {}),
    ...(pushAuth ? { pushAuth } : {}),
    ...(agentPushAuth ? { agentPushAuth } : {}),
    ...(dryRun ? { dryRun: true } : {}),
    ...(runtime.observability?.telemetry ? { telemetry: runtime.observability.telemetry } : {}),
  });

  // M16: audit the consequential actions the responder took.
  if (!dryRun) {
    const auditPath = auditLogPath(resolve("out"));
    const redactPatterns = agentConfig.policy.redactPatterns;
    for (const thread of result.threads) {
      if (thread.action === "fixed") {
        await emitAudit({ path: auditPath, action: "pr.fix-applied", actor: "respond-to-pr", target: values.issue, detail: { pullRequestId, threadId: thread.threadId, instruction: thread.instruction }, redactPatterns });
      } else if (thread.action === "proposed") {
        await emitAudit({ path: auditPath, action: "rule.proposed", actor: "respond-to-pr", target: values.issue, detail: { pullRequestId, intent: thread.intent, instruction: thread.instruction }, redactPatterns });
      }
    }
  }

  printResult(result);
  return 0;
}

/**
 * Resolve the @update-agent target: MANSO_AGENT_REPO must point at a local
 * Manso checkout with an Azure DevOps or GitHub remote. Returns empty when
 * unset or not resolvable — @update-agent then refuses cleanly in the responder.
 */
async function resolveAgentRepo(
  runtime: RuntimeConfig,
): Promise<{ agentRepoRoot?: string; agentAdapter?: VcsAdapter; agentPushAuth?: GitPushAuth }> {
  const configured = process.env.MANSO_AGENT_REPO;
  if (!configured || configured.trim().length === 0) {
    return {};
  }
  const agentRepoRoot = resolve(configured.trim());
  const tokens = vcsTokensFromRuntime(runtime);
  const resolution = await resolveVcsAdapter(agentRepoRoot, tokens);
  if (!resolution.ok) {
    console.warn(`! MANSO_AGENT_REPO (${agentRepoRoot}): ${resolution.reason} @update-agent will be refused.`);
    return { agentRepoRoot };
  }
  const agentPushAuth = await resolveGitPushAuth(agentRepoRoot, tokens);
  return {
    agentRepoRoot,
    agentAdapter: resolution.adapter,
    ...(agentPushAuth ? { agentPushAuth } : {}),
  };
}

function printResult(result: RespondToPrResult): void {
  for (const warning of result.warnings) {
    console.warn(`! ${warning}`);
  }
  if (result.threads.length === 0) {
    console.log(`No actionable @mentions on PR ${result.pullRequestId}.`);
    return;
  }
  console.log(`Responder iteration ${result.iteration} on PR ${result.pullRequestId}:`);
  for (const thread of result.threads) {
    const verify = thread.verification ? ` (verify exit ${thread.verification.exitCode})` : "";
    console.log(`  [${thread.action}] thread ${thread.threadId} — intent=${thread.intent}${verify}`);
    if (thread.reason) console.log(`      ${thread.reason}`);
  }
}

const command: CommandModule = { run };
export default command;
