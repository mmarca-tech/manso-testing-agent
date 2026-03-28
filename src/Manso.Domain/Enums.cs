namespace Manso.Domain;

public enum RunStatus
{
    Queued,
    Running,
    Succeeded,
    PartialSuccess,
    Failed,
    Cancelled,
}

public enum GenerationMode
{
    TestCasesOnly,
    ExecutableTests,
}

public enum WorkflowPass
{
    ScenarioDesign,
    AutomationImplementation,
}

public enum OutputTarget
{
    JiraComment,
    DraftPullRequest,
    Both,
}

public enum DocumentationMode
{
    ExplicitOnly,
    ExplicitOnlyNoDocs,
}

public enum TestScope
{
    Unit,
    Api,
    Integration,
    Ui,
    E2E,
}

public enum CoverageIntent
{
    HappyPathOnly,
    Regression,
    EdgeCases,
    HighRisk,
}

public enum RunStageName
{
    RequestAccepted,
    RequestNormalized,
    JiraContextCollected,
    ConfluenceResolved,
    RepositoryResolved,
    CodeContextCollected,
    XrayContextCollected,
    ContextBundleBuilt,
    ScenariosGenerated,
    TestsGenerated,
    OutputsValidated,
    OutputsWritten,
    JiraUpdated,
}

public enum RunStageStatus
{
    Running,
    Succeeded,
    Failed,
    Skipped,
}
