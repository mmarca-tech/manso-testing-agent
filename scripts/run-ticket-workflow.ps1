<#
.SYNOPSIS
Runs the Jira ticket context, enrichment, review, and Xray generation workflow.

.EXAMPLE
.\scripts\run-ticket-workflow.ps1 -Issue ABC-123 -Out ./out -DryRunGeneration

.EXAMPLE
.\scripts\run-ticket-workflow.ps1 -Issue ABC-123 -Out ./out -SkipPrChanges -SkipConfluenceImpact -DryRunGeneration

.EXAMPLE
.\scripts\run-ticket-workflow.ps1 -Issue ABC-123 -Out ./out -ContinueOnOptionalFailure

.EXAMPLE
.\scripts\run-ticket-workflow.ps1 -Issue ABC-123 -Out ./out -ImplementXrayTests -TestImplementationCommand "codex exec -"
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $Issue,

    [string] $Out = "./out",

    [string] $Config,

    [switch] $Install,

    [switch] $Build,

    [switch] $SkipPrChanges,

    [switch] $SkipConfluenceImpact,

    [switch] $SkipXrayReview,

    [switch] $SkipXrayGeneration,

    [switch] $DryRunGeneration,

    [switch] $ImplementXrayTests,

    [switch] $ImplementationPromptOnly,

    [switch] $AllowDirtyImplementation,

    [string] $TestImplementationCommand,

    [string] $TestVerificationCommand,

    [string] $ImplementationBranch,

    [string] $ImplementationTargetBranch,

    [string] $ImplementationRepo,

    [switch] $ContinueOnOptionalFailure
)

$ErrorActionPreference = "Stop"
$WorkflowStartedAt = Get-Date

function Write-WorkflowLog {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Message
    )

    $elapsed = ((Get-Date) - $WorkflowStartedAt).TotalSeconds.ToString("0.0")
    Write-Host "[$elapsed s] $Message"
}

function Invoke-ProcessStep {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Name,

        [Parameter(Mandatory = $true)]
        [string[]] $Arguments,

        [switch] $Optional
    )

    $stepStartedAt = Get-Date
    Write-Host ""
    Write-WorkflowLog "Starting: $Name"
    Write-WorkflowLog "Command: npm $($Arguments -join ' ')"

    try {
        & npm @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "$Name failed with exit code $LASTEXITCODE."
        }

        $duration = ((Get-Date) - $stepStartedAt).TotalSeconds.ToString("0.0")
        Write-WorkflowLog "Completed: $Name in ${duration}s"
    }
    catch {
        $duration = ((Get-Date) - $stepStartedAt).TotalSeconds.ToString("0.0")
        if ($Optional -and $ContinueOnOptionalFailure) {
            Write-Warning "$Name failed after ${duration}s, continuing because -ContinueOnOptionalFailure was set. $($_.Exception.Message)"
            return
        }

        throw "$Name failed after ${duration}s. $($_.Exception.Message)"
    }
}

function Add-CommonArgs {
    param(
        [Parameter(Mandatory = $true)]
        [string[]] $Arguments
    )

    $output = [System.Collections.Generic.List[string]]::new()
    $Arguments | ForEach-Object { $output.Add($_) }

    if ($Config) {
        $output.Add("--config")
        $output.Add($Config)
    }

    return $output.ToArray()
}

if ($Install) {
    Invoke-ProcessStep -Name "Install dependencies" -Arguments @("install")
}

if ($Build) {
    Invoke-ProcessStep -Name "Build TypeScript" -Arguments @("run", "build")
}

Write-WorkflowLog "Running ticket workflow for $Issue."

$extractArgs = Add-CommonArgs -Arguments @("run", "extract-ticket", "--", "--issue", $Issue, "--out", $Out)
Invoke-ProcessStep -Name "Extract Jira ticket context" -Arguments $extractArgs

if (-not $SkipPrChanges) {
    $prArgs = Add-CommonArgs -Arguments @("run", "summarize-pr-changes", "--", "--issue", $Issue, "--out", $Out)
    Invoke-ProcessStep -Name "Summarize linked pull request changes" -Arguments $prArgs -Optional
}

if (-not $SkipConfluenceImpact) {
    $confluenceArgs = Add-CommonArgs -Arguments @("run", "summarize-confluence-impact", "--", "--issue", $Issue, "--out", $Out)
    Invoke-ProcessStep -Name "Summarize Confluence impact" -Arguments $confluenceArgs -Optional
}

if (-not $SkipXrayReview) {
    $reviewArgs = Add-CommonArgs -Arguments @("run", "review-xray-tests", "--", "--issue", $Issue, "--out", $Out)
    Invoke-ProcessStep -Name "Review linked Xray tests" -Arguments $reviewArgs -Optional
}

if (-not $SkipXrayGeneration) {
    $generationArgs = [System.Collections.Generic.List[string]]::new()
    (Add-CommonArgs -Arguments @("run", "generate-xray-tests", "--", "--issue", $Issue, "--out", $Out)) | ForEach-Object {
        $generationArgs.Add($_)
    }

    if ($DryRunGeneration) {
        $generationArgs.Add("--dry-run")
    }

    Invoke-ProcessStep -Name "Generate Xray tests" -Arguments $generationArgs.ToArray()
}

if ($ImplementXrayTests) {
    $implementationArgs = [System.Collections.Generic.List[string]]::new()
    (Add-CommonArgs -Arguments @("run", "implement-xray-tests", "--", "--issue", $Issue, "--out", $Out)) | ForEach-Object {
        $implementationArgs.Add($_)
    }

    if ($TestImplementationCommand) {
        $implementationArgs.Add("--agent-command")
        $implementationArgs.Add($TestImplementationCommand)
    }

    if ($TestVerificationCommand) {
        $implementationArgs.Add("--verify-command")
        $implementationArgs.Add($TestVerificationCommand)
    }

    if ($ImplementationBranch) {
        $implementationArgs.Add("--branch")
        $implementationArgs.Add($ImplementationBranch)
    }

    if ($ImplementationTargetBranch) {
        $implementationArgs.Add("--target-branch")
        $implementationArgs.Add($ImplementationTargetBranch)
    }

    if ($ImplementationRepo) {
        $implementationArgs.Add("--repo")
        $implementationArgs.Add($ImplementationRepo)
    }

    if ($ImplementationPromptOnly) {
        $implementationArgs.Add("--prompt-only")
    }

    if ($AllowDirtyImplementation) {
        $implementationArgs.Add("--allow-dirty")
    }

    Invoke-ProcessStep -Name "Implement generated Xray test cases" -Arguments $implementationArgs.ToArray()
}

Write-Host ""
$outputPath = Join-Path $Out $Issue
$totalDuration = ((Get-Date) - $WorkflowStartedAt).TotalSeconds.ToString("0.0")
Write-WorkflowLog "Workflow completed for $Issue in ${totalDuration}s. Outputs are under $outputPath."
