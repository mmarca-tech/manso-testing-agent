namespace Manso.Domain;

public sealed record XrayTestSetSearchRequest(
    string Jql,
    int Limit);
