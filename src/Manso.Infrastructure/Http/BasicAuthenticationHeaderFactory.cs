using System.Net.Http.Headers;
using System.Text;

namespace Manso.Infrastructure;

internal static class BasicAuthenticationHeaderFactory
{
    public static AuthenticationHeaderValue Create(string userName, string secret)
    {
        var credentialBytes = Encoding.UTF8.GetBytes($"{userName}:{secret}");
        return new AuthenticationHeaderValue("Basic", Convert.ToBase64String(credentialBytes));
    }
}
