[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$SshHost,

    [string]$Branch = "server",

    [string]$RemoteName = "origin",

    [string]$RemoteAppDir = "/srv/maverick/app",

    [string]$ServiceName = "maverick",

    [string]$ForwardedGitHubKeyPath,

    [switch]$SkipLocalChecks,

    [switch]$SkipPush
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (-not $ForwardedGitHubKeyPath) {
    $ForwardedGitHubKeyPath = Join-Path $env:USERPROFILE ".ssh\id_ed25519"
}

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
        [ValidateSet("ssh", "ssh-agent", "ssh-add")]
        [string]$Tool
    )

    $gitTool = Join-Path $env:ProgramFiles "Git\usr\bin\$Tool.exe"
    if (Test-Path $gitTool) {
        return $gitTool
    }

    return $Tool
}

function Ensure-ForwardedGitHubKey {
    param(
        [Parameter(Mandatory = $true)]
        [string]$KeyPath
    )

    if (-not (Test-Path $KeyPath)) {
        throw "GitHub SSH key not found: $KeyPath"
    }

    $sshAddPath = Get-SshToolPath -Tool "ssh-add"
    $hasAgent = $false

    if ($env:SSH_AUTH_SOCK) {
        & $sshAddPath "-l" *> $null
        $hasAgent = ($LASTEXITCODE -eq 0 -or $LASTEXITCODE -eq 1)
    }

    if (-not $hasAgent) {
        $sshAgentPath = Get-SshToolPath -Tool "ssh-agent"
        $agentOutput = & $sshAgentPath "-s"
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to start an SSH agent for GitHub auth forwarding."
        }

        foreach ($line in $agentOutput) {
            if ($line -match '^SSH_AUTH_SOCK=([^;]+);') {
                $env:SSH_AUTH_SOCK = $matches[1]
            }
            elseif ($line -match '^SSH_AGENT_PID=([0-9]+);') {
                $env:SSH_AGENT_PID = $matches[1]
                $script:StartedSshAgentPid = [int]$matches[1]
            }
        }
    }

    Invoke-NativeCommand -FilePath $sshAddPath -Arguments @($KeyPath)
}

function Stop-TransientSshAgent {
    if ($script:StartedSshAgentPid) {
        try {
            Stop-Process -Id $script:StartedSshAgentPid -Force -ErrorAction Stop
        }
        catch {
        }

        Remove-Item Env:SSH_AUTH_SOCK -ErrorAction SilentlyContinue
        Remove-Item Env:SSH_AGENT_PID -ErrorAction SilentlyContinue
        $script:StartedSshAgentPid = $null
    }
}

function Invoke-SshCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Command
    )

    Invoke-NativeCommand -FilePath (Get-SshToolPath -Tool "ssh") -Arguments @("-A", $SshHost, "bash", "-lc", $Command)
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
    "sudo --preserve-env=SSH_AUTH_SOCK -- git -C $RemoteAppDir -c safe.directory=$RemoteAppDir fetch --all --prune",
    "sudo --preserve-env=SSH_AUTH_SOCK -- git -C $RemoteAppDir -c safe.directory=$RemoteAppDir checkout $Branch",
    "sudo --preserve-env=SSH_AUTH_SOCK -- git -C $RemoteAppDir -c safe.directory=$RemoteAppDir pull --ff-only origin $Branch",
    "sudo -- chown -R maverick:maverick $RemoteAppDir",
    "sudo -u maverick -H -- npm --prefix $RemoteAppDir ci --include=dev",
    "sudo -u maverick -H -- npm --prefix $RemoteAppDir run build",
    "sudo -- systemctl restart $ServiceName",
    "sleep 3",
    "curl --fail --silent http://127.0.0.1:3847/health"
) -join " && "

try {
    Ensure-ForwardedGitHubKey -KeyPath $ForwardedGitHubKeyPath
    Invoke-SshCommand -Command $remoteCommand
}
catch {
    $diagnostics = "sudo systemctl status $ServiceName --no-pager -l || true; sudo journalctl -u $ServiceName -n 100 --no-pager || true"
    Invoke-SshCommand -Command $diagnostics
    throw
}
finally {
    Stop-TransientSshAgent
}
