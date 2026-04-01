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
