namespace Manso.Domain;

public sealed record JiraDevelopmentRepository(
    string Name,
    string? Url,
    IReadOnlyList<JiraDevelopmentBranch> Branches,
    IReadOnlyList<JiraDevelopmentPullRequest> PullRequests);
