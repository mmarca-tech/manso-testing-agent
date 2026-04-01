namespace Manso.Domain;

public sealed record XrayTestSearchRequest(
    string Jql,
    int Limit);
