using Manso.Api;
using Manso.Application;
using Manso.Domain;
using Manso.Infrastructure;

var builder = WebApplication.CreateBuilder(args);

builder.Logging.ClearProviders();
builder.Logging.AddJsonConsole(options => options.IncludeScopes = true);
builder.Services.AddApiJsonSerialization();
builder.Services.AddApiComposition(builder.Configuration);

var app = builder.Build();

await app.InitializeRunPersistenceAsync();
app.UseApiRequestPipeline();
app.MapRunApi();

app.Run();

public partial class Program
{
}
