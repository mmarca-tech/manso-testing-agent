using System.Globalization;
using Manso.Application;

namespace Manso.Infrastructure;

public sealed class UtcTimestampRunIdFactory : IRunIdFactory
{
    private readonly TimeProvider _timeProvider;
    private readonly object _sync = new();
    private int _sequence;
    private string _currentDay = string.Empty;

    public UtcTimestampRunIdFactory(TimeProvider timeProvider)
    {
        _timeProvider = timeProvider;
    }

    public string Create()
    {
        lock (_sync)
        {
            var day = _timeProvider.GetUtcNow().ToString("yyyyMMdd", CultureInfo.InvariantCulture);
            if (!string.Equals(day, _currentDay, StringComparison.Ordinal))
            {
                _currentDay = day;
                _sequence = 0;
            }

            _sequence++;
            return $"RUN-{day}-{_sequence:0000}";
        }
    }
}
