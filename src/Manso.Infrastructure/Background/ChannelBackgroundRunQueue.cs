using Manso.Application;
using System.Threading.Channels;

namespace Manso.Infrastructure;

public sealed class ChannelBackgroundRunQueue : IBackgroundRunQueue
{
    private readonly Channel<string> _channel = Channel.CreateUnbounded<string>(new UnboundedChannelOptions
    {
        SingleReader = true,
        SingleWriter = false,
    });

    public ValueTask QueueAsync(string runId, CancellationToken ct)
        => _channel.Writer.WriteAsync(runId, ct);

    public ValueTask<string> DequeueAsync(CancellationToken ct)
        => _channel.Reader.ReadAsync(ct);
}
