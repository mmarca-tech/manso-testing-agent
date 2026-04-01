namespace Manso.Domain;

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
