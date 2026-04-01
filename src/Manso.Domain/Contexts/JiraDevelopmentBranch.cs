namespace Manso.Domain;

public sealed record JiraDevelopmentBranch(
    string Name,
    string? Url,
    string? CreatePullRequestUrl);
