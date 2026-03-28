FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
ARG BUILD_CONFIGURATION=Release
WORKDIR /src

COPY src/Manso.Api/Manso.Api.csproj src/Manso.Api/
COPY src/Manso.Application/Manso.Application.csproj src/Manso.Application/
COPY src/Manso.Domain/Manso.Domain.csproj src/Manso.Domain/
COPY src/Manso.Infrastructure/Manso.Infrastructure.csproj src/Manso.Infrastructure/

RUN dotnet restore src/Manso.Api/Manso.Api.csproj

COPY src/ src/

RUN dotnet publish src/Manso.Api/Manso.Api.csproj \
    --configuration $BUILD_CONFIGURATION \
    --output /app/publish \
    /p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS final
WORKDIR /app

EXPOSE 8080
ENV ASPNETCORE_URLS=http://+:8080

COPY --from=build /app/publish .

ENTRYPOINT ["dotnet", "Manso.Api.dll"]
