using Manso.Application;
using System.Globalization;

namespace Manso.Infrastructure;

public sealed class UtcTimestampRunIdFactory : IRunIdFactory
{
    private readonly TimeProvider _timeProvider;
    private readonly object _sync = new();
    private string _currentTimestamp = string.Empty;
    private int _sequence;

    public UtcTimestampRunIdFactory(TimeProvider timeProvider)
    {
        _timeProvider = timeProvider;
    }

    public string Create()
    {
        lock (_sync)
        {
            var timestamp = _timeProvider.GetUtcNow().ToString("yyyyMMdd-HHmmssfff", CultureInfo.InvariantCulture);
            if (!string.Equals(timestamp, _currentTimestamp, StringComparison.Ordinal))
            {
                _currentTimestamp = timestamp;
                _sequence = 0;
            }
            else
            {
                _sequence++;
            }

            return $"RUN-{timestamp}-{_sequence:0000}";
        }
    }
}
