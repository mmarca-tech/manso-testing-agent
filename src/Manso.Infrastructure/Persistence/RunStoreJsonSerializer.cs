using System.Text.Json;
using System.Text.Json.Serialization;

namespace Manso.Infrastructure;

public sealed class RunStoreJsonSerializer
{
    private readonly JsonSerializerOptions _options = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = false,
    };

    public RunStoreJsonSerializer()
    {
        _options.Converters.Add(new JsonStringEnumConverter());
    }

    public string Serialize<T>(T value)
        => JsonSerializer.Serialize(value, _options);

    public T Deserialize<T>(string json)
        => JsonSerializer.Deserialize<T>(json, _options)
           ?? throw new InvalidOperationException($"Failed to deserialize JSON payload to '{typeof(T).Name}'.");
}
