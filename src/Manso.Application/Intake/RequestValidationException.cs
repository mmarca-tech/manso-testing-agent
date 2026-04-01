namespace Manso.Application;

public sealed class RequestValidationException : Exception
{
    public RequestValidationException(string message, string? field = null, string? value = null)
        : base(message)
    {
        Field = field;
        Value = value;
    }

    public string? Field { get; }

    public string? Value { get; }
}
