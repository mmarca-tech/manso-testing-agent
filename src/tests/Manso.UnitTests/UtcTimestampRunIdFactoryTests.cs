using Manso.Infrastructure;

namespace Manso.UnitTests;

public sealed class UtcTimestampRunIdFactoryTests
{
    [Fact]
    public void Create_IncludesUtcTimestampAndSequence()
    {
        var factory = new UtcTimestampRunIdFactory(new FakeTimeProvider(
            new DateTimeOffset(2026, 04, 29, 10, 11, 12, 123, TimeSpan.Zero)));

        Assert.Equal("RUN-20260429-101112123-0000", factory.Create());
        Assert.Equal("RUN-20260429-101112123-0001", factory.Create());
    }

    [Fact]
    public void Create_ResetsSequence_WhenTimestampChanges()
    {
        var timeProvider = new MutableTimeProvider(
            new DateTimeOffset(2026, 04, 29, 10, 11, 12, 123, TimeSpan.Zero));
        var factory = new UtcTimestampRunIdFactory(timeProvider);

        Assert.Equal("RUN-20260429-101112123-0000", factory.Create());

        timeProvider.UtcNow = new DateTimeOffset(2026, 04, 29, 10, 11, 12, 124, TimeSpan.Zero);

        Assert.Equal("RUN-20260429-101112124-0000", factory.Create());
    }

    private sealed class FakeTimeProvider : TimeProvider
    {
        private readonly DateTimeOffset _utcNow;

        public FakeTimeProvider(DateTimeOffset utcNow)
        {
            _utcNow = utcNow;
        }

        public override DateTimeOffset GetUtcNow() => _utcNow;
    }

    private sealed class MutableTimeProvider : TimeProvider
    {
        public MutableTimeProvider(DateTimeOffset utcNow)
        {
            UtcNow = utcNow;
        }

        public DateTimeOffset UtcNow { get; set; }

        public override DateTimeOffset GetUtcNow() => UtcNow;
    }
}
