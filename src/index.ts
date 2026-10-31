/**
 * Manso public library surface.
 *
 * Every CLI verb is also usable as a library API. This barrel grows as
 * milestones land; for now it exposes the version reader, the CLI dispatcher,
 * and the shared error type.
 */
export { readVersion } from "./cli/version.js";
export { withMemoryCabin, registerCabinArtifacts, supplementalCabinContext } from "./memory/cabin.js";
export type { MemoryCabinOptions, CabinArtifact } from "./memory/cabin.js";
export { loadMemoryCabinConfig, MemoryCabinConfigSchema } from "./memory/config.js";
export type { MemoryCabinConfig } from "./memory/config.js";
export { runCli, KNOWN_COMMANDS } from "./cli/main.js";
export type { CommandModule, KnownCommand } from "./cli/main.js";
export { CliError } from "./shared/cli.js";
export { runReviewPullRequest } from "./cli/reviewPullRequest.js";
export type { ReviewPullRequestInput, ReviewPullRequestOutput } from "./cli/reviewPullRequest.js";
export { runPullRequestReviewer, detectJiraIssueKey } from "./agents/pullRequestReviewer/index.js";
export { CodeReviewPackSchema, CodeReviewResultSchema } from "./domain/codeReview/schema.js";
export type { CodeReviewFinding, CodeReviewPack, CodeReviewResult } from "./domain/codeReview/schema.js";
export { scaffoldAgentFolder } from "./scaffold/scaffold.js";
export type { ScaffoldOptions, ScaffoldResult } from "./scaffold/scaffold.js";
export { detectStacks } from "./scaffold/stackDetection.js";
export type { DetectedStack } from "./scaffold/stackDetection.js";
export { loadAgentConfig, parseAgentConfig, agentConfigPath } from "./config/agentConfig.js";
export type { AgentConfig, StackConfig } from "./config/agentConfig.js";
export {
  McpServerConfigSchema,
  McpServersSchema,
  resolveMcpServers,
  toCodexMcpConfig,
  describeMcpServers,
} from "./integrations/mcp/config.js";
export type { McpServerConfig, McpServers, ResolveMcpServersResult } from "./integrations/mcp/config.js";
export { loadRuntimeConfig } from "./config/runtimeConfig.js";
export type { RuntimeConfig } from "./config/runtimeConfig.js";
export { evaluateRepoReadiness } from "./checks/readiness.js";
export type { ReadinessReport, ReadinessCheck } from "./domain/readinessReport/schema.js";
export { ProviderRegistry } from "./context/providerRegistry.js";
export type { ContextProvider, ContextProviderName } from "./context/providerRegistry.js";
export { buildEvidenceGraph } from "./context/evidenceGraph.js";
export type { EvidenceGraph } from "./context/evidenceGraph.js";
export type { EvidenceGraphNode, EvidenceGraphEdge } from "./domain/contextPack/schema.js";
export { analyzeAttachments, classifyAttachment } from "./context/attachmentAnalysis.js";
export type { AttachmentKind, AnalyzeAttachmentsInput, DescribeImage } from "./context/attachmentAnalysis.js";
export type { AttachmentContent } from "./workflows/ticket-context/ticketSource.js";
export { buildImageAnalysisRequest, createImageDescriber } from "./context/visionAnalysis.js";
export type { ImageDescriberInput } from "./context/visionAnalysis.js";
export {
  KnowledgeIndex,
  buildKnowledgeIndex,
  chunkContext,
  tokenize,
  freshnessKey,
} from "./context/knowledgeIndex.js";
export type { KnowledgeChunk, RetrievalResult } from "./context/knowledgeIndex.js";
export { createJiraRestProvider } from "./context/providers/jiraRestProvider.js";
export type { JiraRestProviderOptions } from "./context/providers/jiraRestProvider.js";
export { AtlassianRestClient } from "./integrations/atlassianRest/client.js";
export type { AtlassianRestCredentials, AtlassianRestClientOptions } from "./integrations/atlassianRest/client.js";
export { AtlassianRestSource } from "./integrations/atlassianRest/source.js";
export { ContextPackSchema } from "./domain/contextPack/schema.js";
export type {
  ContextPack,
  Ticket,
  TicketLink,
  Comment,
  Attachment,
  RelatedTicket,
  XrayTestCase,
  ConfluencePage,
  Development,
  Branch,
  PullRequest,
  ToolProvenance,
  Warning,
} from "./domain/contextPack/schema.js";
export type { NormalizedIssue } from "./domain/tickets/normalizedIssue.js";
export { loadSkills, packagedSkillsRoot, repoSkillsRoot } from "./skillLoader/loader.js";
export { parseSkill } from "./skillLoader/parser.js";
export { SKILL_PHASES } from "./skillLoader/types.js";
export type { Skill, SkillAppliesTo, SkillPhase } from "./skillLoader/types.js";
export { runResearcher } from "./agents/researcher/index.js";
export type { ResearcherInput } from "./agents/researcher/index.js";
export { runAgenticRetrieval } from "./agents/researcher/agenticRetrieval.js";
export type {
  AgenticRetrievalResult,
  AgenticStep,
  RunAgenticRetrievalInput,
} from "./agents/researcher/agenticRetrieval.js";
export {
  extractStepLibrary,
  formatStepLibraryForPrompt,
  formatExistingScenariosForPrompt,
  normalizeStepText,
  resolveDesignRepo,
} from "./context/stepLibrary.js";
export type {
  StepLibrary,
  StepLibraryEntry,
  ExistingScenario,
  ExtractStepLibraryOptions,
  ResolveDesignRepoInput,
  ResolvedDesignRepo,
} from "./context/stepLibrary.js";
export { runDesignTests } from "./cli/designTests.js";
export type { DesignTestsInput, DesignTestsOutput, StepLibrarySummary } from "./cli/designTests.js";
export { writeContextPack } from "./output/context-pack/writer.js";
export type { WriteResult } from "./output/context-pack/writer.js";
export { renderMarkdown as renderContextPackMarkdown } from "./output/context-pack/renderer.js";
export { runTestArchitect } from "./agents/testArchitect/index.js";
export type { TestArchitectInput, TestArchitectOutput } from "./agents/testArchitect/index.js";
export { TestDesignPackSchema, TEST_DESIGN_SCHEMA_VERSION } from "./domain/testDesignPack/schema.js";
export type {
  TestDesignPack,
  GherkinScenario,
  PlainEnglishScenario,
  PlainEnglishStep,
  TestScenario,
  GherkinStep,
  GherkinExamples,
  AcCoverageEntry,
  RiskRankingEntry,
  RiskLevel,
  ReadinessLevel,
  SourceEvidence,
} from "./domain/testDesignPack/schema.js";
export { writeTestDesignPack } from "./output/test-design/writer.js";
export type { WriteTestDesignResult } from "./output/test-design/writer.js";
export { renderTestDesignMarkdown, renderFeatureFile, renderManualTests } from "./output/test-design/renderer.js";
export { designScenarios } from "./agents/testArchitect/scenarioAuthoring.js";
export type { OutputMode, ScenarioDesignResult } from "./agents/testArchitect/scenarioAuthoring.js";
export { createLlmTextClient } from "./integrations/llm/factory.js";
export type {
  LlmTextClient,
  LlmRuntimeConfig,
  LlmProvider,
  LlmTextGenerationRequest,
  LlmImageInput,
  OpenAiApiStyle,
} from "./integrations/llm/types.js";
export { OpenAiChatCompletionsLlmClient } from "./integrations/llm/clients/openAiChatCompletionsClient.js";
export { OpenAiResponsesLlmClient } from "./integrations/llm/clients/openAiResponsesClient.js";
export { AnthropicMessagesLlmClient } from "./integrations/llm/clients/anthropicMessagesClient.js";
export { auditCoverage } from "./agents/coverageAuditor/index.js";
export type { AcCoverageGate, CoverageAuditInput, CoverageAuditResult } from "./agents/coverageAuditor/index.js";
export { XrayCloudClient } from "./integrations/xray/client.js";
export type { XrayCloudClientOptions } from "./integrations/xray/client.js";
export { applyTestDesignToXray, renderScenarioGherkin } from "./integrations/xray/testDesignSink.js";
export type { ApplyTestDesignInput } from "./integrations/xray/testDesignSink.js";
export type { XrayApplication, XrayAppliedTest } from "./domain/testDesignPack/schema.js";
export {
  CodexSdkRunner,
  ClaudeSdkRunner,
  ShellImplementationAgentRunner,
  resolveImplementationAgentRunners,
  runImplementationAgent,
} from "./integrations/llm/agentRunner.js";
export type {
  ImplementationAgentRunner,
  ImplementationAgentRunInput,
  ImplementationAgentRunnerKind,
  ImplementationAgentPhase,
  ResolvedImplementationAgentRunners,
} from "./integrations/llm/agentRunner.js";
export {
  resolveSandboxProfile,
  codexSandboxSettings,
  claudeSandboxSettings,
  isSandboxProfile,
  SANDBOX_PROFILES,
  DEFAULT_SANDBOX_PROFILE,
} from "./integrations/llm/sandbox.js";
export type { SandboxProfile, CodexSandboxSettings, ClaudeSandboxSettings } from "./integrations/llm/sandbox.js";
export { runImplementer } from "./agents/implementer/index.js";
export type { ImplementerInput, ImplementerOutput } from "./agents/implementer/index.js";
export { runVerifier } from "./agents/verifier/index.js";
export type { VerifierInput } from "./agents/verifier/index.js";
export { runImplementTests } from "./cli/implementTests.js";
export type { RunImplementTestsInput, RunImplementTestsOutput } from "./cli/implementTests.js";
export { ImplementationPackSchema, IMPLEMENTATION_SCHEMA_VERSION } from "./domain/implementationPack/schema.js";
export type {
  ImplementationPack,
  ImplementationStatus,
  ImplementedScenario,
  CommandResult,
  AgentUsage,
  HealingAttempt,
  PullRequestReference,
} from "./domain/implementationPack/schema.js";
export { writeImplementationPack } from "./output/implementation/writer.js";
export type { WriteImplementationResult } from "./output/implementation/writer.js";
export { renderImplementationMarkdown } from "./output/implementation/renderer.js";
export { runShellCommand } from "./integrations/shell/runShellCommand.js";
export type { ShellRunOptions, ShellRunResult } from "./integrations/shell/runShellCommand.js";
export { buildImplementationPrompt, buildHealingPrompt } from "./agents/implementer/prompts.js";
export type {
  BuildImplementationPromptInput,
  BuildHealingPromptInput,
  RepoGuidanceFile,
} from "./agents/implementer/prompts.js";
export { runHealer } from "./agents/healer/index.js";
export type { HealerInput, HealerResult } from "./agents/healer/index.js";
export { runRespondToPr } from "./agents/responder/index.js";
export type { RespondToPrInput, RespondToPrResult, RespondedThread } from "./agents/responder/index.js";
export {
  parseMention,
  classifyIntent,
  markReply,
  isResponderComment,
  highestIteration,
  RESPONDER_MARKER,
} from "./agents/responder/mention.js";
export type { MentionIntent, ParsedMention } from "./agents/responder/mention.js";
export { buildFeedbackPrompt } from "./agents/responder/prompts.js";
export type { BuildFeedbackPromptInput } from "./agents/responder/prompts.js";
export { classifyLearning } from "./agents/learningEngine/classify.js";
export type { Classification } from "./agents/learningEngine/classify.js";
export { captureLearnings, buildGuidelineEdits, hasProposals } from "./agents/learningEngine/index.js";
export type { LearningSignal, CaptureLearningsInput, GuidelineEdit } from "./agents/learningEngine/index.js";
export { proposeLearningsPr, applyGuidelineEdits } from "./agents/learningEngine/proposer.js";
export type { ProposeLearningsInput, ProposeLearningsResult } from "./agents/learningEngine/proposer.js";
export { parseUpdateMention, runKnowledgeUpdate, UPDATE_HANDLES } from "./agents/learningEngine/knowledgeUpdate.js";
export type {
  ParsedUpdateMention,
  RunKnowledgeUpdateInput,
  KnowledgeUpdateResult,
} from "./agents/learningEngine/knowledgeUpdate.js";
export { guidelineTargetPath } from "./agents/learningEngine/index.js";
export type { LearningScope } from "./agents/learningEngine/index.js";
// Governance + eval (M14)
export { buildRedactor, redactText, REDACTION_PLACEHOLDER } from "./policy/redaction.js";
export type { Redactor } from "./policy/redaction.js";
export { checkBudget, sumUsageCost } from "./policy/budget.js";
export type { CostBudget, BudgetDecision, BudgetBreach, BudgetCheckInput } from "./policy/budget.js";
export { appendAuditEntry, readAuditLog, emitAudit, auditLogPath, AUDIT_ACTIONS } from "./policy/auditLog.js";
export type { AuditEntry, AuditAction, AppendAuditInput } from "./policy/auditLog.js";
export { appendRunCost, readDayCost, costLedgerPath, ledgerDay } from "./policy/costLedger.js";
export type { CostLedgerEntry } from "./policy/costLedger.js";
export { scoreTestDesign } from "./eval/scorer.js";
export type { EvalScore, EvalCheck } from "./eval/scorer.js";
export { runEval, analyzeVariance, renderEvalReport } from "./eval/harness.js";
export type { EvalCase, EvalCaseResult, EvalReport, VarianceReport, RunEvalInput } from "./eval/harness.js";
export { writeLearningRecordSet, renderLearningMarkdown } from "./output/learning/writer.js";
export type { WriteLearningResult } from "./output/learning/writer.js";
export {
  LearningRecordSchema,
  LearningRecordSetSchema,
  LEARNING_SCHEMA_VERSION,
} from "./domain/learningRecord/schema.js";
export type {
  LearningRecord,
  LearningRecordSet,
  ProposedChange,
  LearningSource,
  LearningClassification,
  LearningCategory,
} from "./domain/learningRecord/schema.js";
export type {
  VcsCommentThread,
  VcsComment,
  VcsPostCommentInput,
  VcsPostCommentResult,
  VcsInlineCommentLocation,
} from "./integrations/vcs/adapter.js";
export { commitChangesOnBranch, defaultBranchName } from "./integrations/git/branchCommit.js";
export type { CommitChangesInput, CommitChangesResult, GitPushAuth } from "./integrations/git/branchCommit.js";
export type { CommitOptions, PullRequestOptions } from "./cli/implementTests.js";
export type {
  VcsAdapter,
  VcsAdapterKind,
  VcsRaisePullRequestInput,
  VcsRaisePullRequestResult,
  VcsRaisePullRequestStatus,
} from "./integrations/vcs/adapter.js";
export {
  AzureDevOpsAdapter,
  detectAzureDevOpsRemote,
  parseAzureDevOpsRemoteUrl,
} from "./integrations/vcs/azureDevOpsAdapter.js";
export type {
  AzureDevOpsAdapterOptions,
  AzureDevOpsRemote,
} from "./integrations/vcs/azureDevOpsAdapter.js";
export {
  GitHubAdapter,
  detectGitHubRemote,
  parseGitHubRemoteUrl,
} from "./integrations/vcs/githubAdapter.js";
export type { GitHubAdapterOptions, GitHubRemote } from "./integrations/vcs/githubAdapter.js";
export { resolveGitPushAuth, resolveVcsAdapter, vcsTokensFromRuntime } from "./integrations/vcs/resolve.js";
export type { VcsResolution, VcsTokens } from "./integrations/vcs/resolve.js";
