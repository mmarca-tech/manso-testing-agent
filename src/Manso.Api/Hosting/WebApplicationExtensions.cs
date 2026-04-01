using Manso.Infrastructure;

namespace Manso.Api;

public static class WebApplicationExtensions
{
    public static async Task InitializeRunPersistenceAsync(this WebApplication app)
    {
        await app.Services.GetRequiredService<RunStoreSchemaInitializer>()
            .InitializeAsync(app.Lifetime.ApplicationStopping);
    }

    public static WebApplication UseApiRequestPipeline(this WebApplication app)
    {
        app.UseMiddleware<CorrelationIdMiddleware>();
        app.UseMiddleware<ExceptionHandlingMiddleware>();
        app.UseMiddleware<BearerTokenAuthenticationMiddleware>();

        return app;
    }
}
