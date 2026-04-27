[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$SshHost,

    [string]$Branch = "main",

    [string]$RemoteName = "origin",

    [string]$RemoteAppDir = "/srv/maverick/app",

    [string]$ServiceName = "maverick",

    [switch]$SkipLocalChecks,

    [switch]$SkipPush
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

function Invoke-NativeCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,

        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed: $FilePath $($Arguments -join ' ')"
    }
}

function Get-SshToolPath {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet("ssh")]
        [string]$Tool
    )

    $gitTool = Join-Path $env:ProgramFiles "Git\usr\bin\$Tool.exe"
    if (Test-Path $gitTool) {
        return $gitTool
    }

    return $Tool
}

function Quote-BashString {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Value
    )

    return "'" + ($Value -replace "'", "'""'""'") + "'"
}

function Invoke-SshCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Command
    )

    Invoke-NativeCommand -FilePath (Get-SshToolPath -Tool "ssh") -Arguments @($SshHost, "bash", "-lc", (Quote-BashString -Value $Command))
}

Invoke-NativeCommand -FilePath "git" -Arguments @("-C", $repoRoot, "rev-parse", "--verify", $Branch)
Invoke-NativeCommand -FilePath "git" -Arguments @("-C", $repoRoot, "remote", "get-url", $RemoteName)

if (-not $SkipLocalChecks) {
    Invoke-NativeCommand -FilePath "npm" -Arguments @("--prefix", $repoRoot, "test")
    Invoke-NativeCommand -FilePath "npm" -Arguments @("--prefix", $repoRoot, "run", "build")
}

if (-not $SkipPush) {
    Invoke-NativeCommand -FilePath "git" -Arguments @("-C", $repoRoot, "push", $RemoteName, $Branch)
}

$remoteCommand = @(
    "set -euo pipefail",
    "sudo -u maverick -H -- git -C $RemoteAppDir -c safe.directory=$RemoteAppDir fetch --all --prune",
    "sudo -u maverick -H -- git -C $RemoteAppDir -c safe.directory=$RemoteAppDir checkout $Branch",
    "sudo -u maverick -H -- git -C $RemoteAppDir -c safe.directory=$RemoteAppDir pull --ff-only origin $Branch",
    "sudo -u maverick -H -- npm --prefix $RemoteAppDir ci --include=dev",
    "sudo -u maverick -H -- npm --prefix $RemoteAppDir run build",
    "sudo -- systemctl restart $ServiceName",
    "for i in {1..20}; do if curl --fail --silent http://127.0.0.1:3847/health; then break; fi; if [ ""`$i"" -eq 20 ]; then exit 1; fi; sleep 1; done"
) -join " && "

try {
    Invoke-SshCommand -Command $remoteCommand
}
catch {
    $diagnostics = "sudo systemctl status $ServiceName --no-pager -l || true; sudo journalctl -u $ServiceName -n 100 --no-pager || true"
    Invoke-SshCommand -Command $diagnostics
    throw
}
