namespace Manso.Infrastructure;

public sealed class RunPersistenceOptions
{
    public const string SectionName = "RunPersistence";

    public RunPersistenceProvider Provider { get; init; } = RunPersistenceProvider.Postgres;

    public bool AutoInitializeSchema { get; init; } = true;
}

public enum RunPersistenceProvider
{
    InMemory,
    Postgres,
}
