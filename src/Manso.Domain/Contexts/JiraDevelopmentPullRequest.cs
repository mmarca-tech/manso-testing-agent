namespace Manso.Domain;

public sealed record JiraDevelopmentPullRequest(
    string Url,
    string? Status,
    string? BranchName,
    string? DestinationBranchName,
    DateTimeOffset? LastUpdatedUtc);
