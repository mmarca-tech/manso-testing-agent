namespace Manso.Domain;

public sealed record RawRunRequest(
    string RequestSource,
    string TriggerType,
    RawIssuePayload Issue,
    RawTriggerInputs TriggerInputs,
    RawRequester RequestedBy);
