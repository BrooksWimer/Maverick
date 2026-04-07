[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$SshHost,

    [string]$Branch = "server",

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

function Invoke-SshCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Command
    )

    Invoke-NativeCommand -FilePath "ssh" -Arguments @($SshHost, "bash", "-lc", $Command)
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
    "cd $RemoteAppDir",
    "git fetch --all --prune",
    "git checkout $Branch",
    "git pull --ff-only origin $Branch",
    "npm ci --include=dev",
    "npm run build",
    "sudo systemctl restart $ServiceName",
    "sleep 2",
    "curl --fail --silent http://127.0.0.1:3847/health"
) -join " && "

try {
    Invoke-SshCommand -Command $remoteCommand
}
catch {
    $diagnostics = "sudo systemctl status $ServiceName --no-pager -l || true; sudo journalctl -u $ServiceName -n 100 --no-pager || true"
    Invoke-SshCommand -Command $diagnostics
    throw
}
