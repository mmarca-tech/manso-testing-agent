param(
    [string]$TagPrefix = 'v',
    [ValidateSet('patch', 'minor', 'major')]
    [string]$DefaultBump = 'patch',
    [string]$CommitMessage = '',
    [string]$RemoteName = 'origin'
)

$ErrorActionPreference = 'Stop'

function Invoke-Git {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $output = & git @Arguments
    if ($LASTEXITCODE -ne 0) {
        $joined = $Arguments -join ' '
        throw "git $joined failed:`n$output"
    }

    return $output
}

function Get-BumpType {
    param(
        [string]$Message,
        [string]$Fallback
    )

    if ([string]::IsNullOrWhiteSpace($Message)) {
        return $Fallback
    }

    $normalized = $Message.ToLowerInvariant()

    if ($normalized -match 'semver:\s*major' -or $normalized -match '\#major' -or $normalized -match '\[major\]') {
        return 'major'
    }

    if ($normalized -match 'semver:\s*minor' -or $normalized -match '\#minor' -or $normalized -match '\[minor\]') {
        return 'minor'
    }

    if ($normalized -match 'semver:\s*patch' -or $normalized -match '\#patch' -or $normalized -match '\[patch\]') {
        return 'patch'
    }

    return $Fallback
}

$resolvedCommitMessage = if (-not [string]::IsNullOrWhiteSpace($CommitMessage)) {
    $CommitMessage
}
elseif (-not [string]::IsNullOrWhiteSpace($env:BUILD_SOURCEVERSIONMESSAGE)) {
    $env:BUILD_SOURCEVERSIONMESSAGE
}
else {
    ''
}

$sourceVersion = if (-not [string]::IsNullOrWhiteSpace($env:BUILD_SOURCEVERSION)) {
    $env:BUILD_SOURCEVERSION
}
else {
    (Invoke-Git -Arguments @('rev-parse', 'HEAD') | Select-Object -First 1)
}

$buildNumber = if (-not [string]::IsNullOrWhiteSpace($env:BUILD_BUILDNUMBER)) {
    $env:BUILD_BUILDNUMBER
}
else {
    'local'
}

Write-Host "Fetching tags from '$RemoteName'."
Invoke-Git -Arguments @('fetch', $RemoteName, '--tags', '--force') | Out-Null

$tagPattern = "$TagPrefix[0-9]*.[0-9]*.[0-9]*"
$currentTag = Invoke-Git -Arguments @('tag', '--points-at', 'HEAD', '--list', $tagPattern) |
    Select-Object -First 1

if (-not [string]::IsNullOrWhiteSpace($currentTag)) {
    Write-Host "Commit already has semantic version tag '$currentTag'. Nothing to do."
    Write-Host "##vso[task.setvariable variable=CreatedTag]$currentTag"
    exit 0
}

$latestTag = Invoke-Git -Arguments @('tag', '--list', $tagPattern, '--sort=-version:refname') |
    Select-Object -First 1

if ([string]::IsNullOrWhiteSpace($latestTag)) {
    $exampleTag = "$TagPrefix" + "1.0.0"
    throw "No semantic version tags matching '$tagPattern' were found. Create the first tag manually, for example '$exampleTag'."
}

$escapedPrefix = [regex]::Escape($TagPrefix)
$versionMatch = [regex]::Match($latestTag, "^$escapedPrefix(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)$")
if (-not $versionMatch.Success) {
    $expectedFormat = "$TagPrefix" + "X.Y.Z"
    throw "Latest tag '$latestTag' does not match the expected format '$expectedFormat'."
}

$major = [int]$versionMatch.Groups['major'].Value
$minor = [int]$versionMatch.Groups['minor'].Value
$patch = [int]$versionMatch.Groups['patch'].Value

$bumpType = Get-BumpType -Message $resolvedCommitMessage -Fallback $DefaultBump
Write-Host "Latest tag is '$latestTag'. Selected bump type is '$bumpType'."

switch ($bumpType) {
    'major' {
        $major += 1
        $minor = 0
        $patch = 0
    }
    'minor' {
        $minor += 1
        $patch = 0
    }
    default {
        $patch += 1
    }
}

$nextTag = "$TagPrefix$major.$minor.$patch"
Write-Host "Creating tag '$nextTag' on commit $sourceVersion."

$tagMessage = @"
Release $nextTag

Created by Azure DevOps build $buildNumber from commit $sourceVersion.
"@

Invoke-Git -Arguments @('config', 'user.name', 'Azure DevOps')
Invoke-Git -Arguments @('config', 'user.email', 'azure-devops@local')
Invoke-Git -Arguments @('tag', '-a', $nextTag, '-m', $tagMessage, 'HEAD') | Out-Null
Invoke-Git -Arguments @('push', $RemoteName, "refs/tags/$nextTag") | Out-Null

Write-Host "Pushed tag '$nextTag'."
Write-Host "##vso[task.setvariable variable=CreatedTag]$nextTag"
