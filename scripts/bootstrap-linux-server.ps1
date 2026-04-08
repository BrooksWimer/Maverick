[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$SshHost,

    [string]$MaverickRepoUrl,

    [string]$NetwiseRepoUrl,

    [string]$SyncSonicRepoUrl,

    [string]$MaverickBranch = "server",

    [string]$NetwiseBranch = "master",

    [string]$SyncSonicBranch = "pi-stable-baseline-2026-04-05",

    [string]$LocalEnvPath,

    [string]$RemoteAppDir = "/srv/maverick/app",

    [string]$RemoteStateDir = "/var/lib/maverick",

    [string]$ServiceName = "maverick",

    [string]$ForwardedGitHubKeyPath,

    [switch]$SkipDatabaseSync
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (-not $LocalEnvPath) {
    $LocalEnvPath = Join-Path $repoRoot ".env"
}
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
        [ValidateSet("ssh", "scp", "ssh-agent", "ssh-add")]
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

function Invoke-GitCapture {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoPath,

        [Parameter(Mandatory = $true)]
        [string[]]$GitArguments
    )

    $output = & git -C $RepoPath @GitArguments 2>$null
    if ($LASTEXITCODE -ne 0) {
        return $null
    }

    return ($output | Out-String).Trim()
}

function Get-RepoPathFromControlPlane {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ProjectId
    )

    $configPath = Join-Path $repoRoot "config\control-plane.json"
    $config = Get-Content -Path $configPath -Raw | ConvertFrom-Json
    $project = $config.projects | Where-Object { $_.id -eq $ProjectId } | Select-Object -First 1

    if (-not $project) {
        throw "Project '$ProjectId' was not found in $configPath"
    }

    return [string]$project.repoPath
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

    Invoke-NativeCommand -FilePath (Get-SshToolPath -Tool "ssh") -Arguments @("-A", $SshHost, "bash", "-lc", $Command)
}

function Copy-ToRemote {
    param(
        [Parameter(Mandatory = $true)]
        [string]$LocalPath,

        [Parameter(Mandatory = $true)]
        [string]$RemotePath
    )

    Invoke-NativeCommand -FilePath (Get-SshToolPath -Tool "scp") -Arguments @($LocalPath, "${SshHost}:${RemotePath}")
}

function Read-DotEnvFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    if (-not (Test-Path $Path)) {
        throw "Env file not found: $Path"
    }

    $values = [ordered]@{}
    foreach ($line in Get-Content -Path $Path) {
        if ([string]::IsNullOrWhiteSpace($line)) {
            continue
        }

        $trimmed = $line.Trim()
        if ($trimmed.StartsWith("#")) {
            continue
        }

        $separatorIndex = $line.IndexOf("=")
        if ($separatorIndex -lt 1) {
            continue
        }

        $key = $line.Substring(0, $separatorIndex).Trim()
        $value = $line.Substring($separatorIndex + 1)
        $values[$key] = $value
    }

    return $values
}

function Write-LfTextFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [string]$Content
    )

    $normalized = $Content.Replace("`r`n", "`n").Replace("`r", "`n")
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $normalized, $encoding)
}

function Write-DotEnvFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [System.Collections.Specialized.OrderedDictionary]$Values
    )

    $lines = foreach ($key in $Values.Keys) {
        "$key=$($Values[$key])"
    }

    Write-LfTextFile -Path $Path -Content (($lines -join "`n") + "`n")
}

$maverickRepoPath = $repoRoot
$netwiseRepoPath = Get-RepoPathFromControlPlane -ProjectId "netwise"
$syncSonicRepoPath = Get-RepoPathFromControlPlane -ProjectId "syncsonic"

if (-not $MaverickRepoUrl) {
    $MaverickRepoUrl = Invoke-GitCapture -RepoPath $maverickRepoPath -GitArguments @("remote", "get-url", "origin")
}
if (-not $NetwiseRepoUrl) {
    $NetwiseRepoUrl = Invoke-GitCapture -RepoPath $netwiseRepoPath -GitArguments @("remote", "get-url", "origin")
}
if (-not $SyncSonicRepoUrl) {
    $SyncSonicRepoUrl = Invoke-GitCapture -RepoPath $syncSonicRepoPath -GitArguments @("remote", "get-url", "origin")
}

if (-not $MaverickRepoUrl) {
    throw "Maverick does not have an origin remote yet. Pass -MaverickRepoUrl once the private repo exists."
}
if (-not $NetwiseRepoUrl) {
    throw "Netwise does not have an origin remote configured."
}
if (-not $SyncSonicRepoUrl) {
    throw "SyncSonic does not have an origin remote configured."
}

$envValues = Read-DotEnvFile -Path $LocalEnvPath
$envValues["NODE_ENV"] = "production"
$envValues["DATABASE_PATH"] = "$RemoteStateDir/orchestrator.db"
$envValues["HTTP_PORT"] = "3847"
$envValues.Remove("CODEX_NODE_PATH")
$envValues.Remove("CODEX_JS_PATH")

$tempEnvPath = [System.IO.Path]::GetTempFileName()
$tempBootstrapPath = [System.IO.Path]::GetTempFileName()
$bootstrapRemotePath = "/tmp/maverick-bootstrap.sh"
$envRemotePath = "/tmp/maverick.env"

try {
    Ensure-ForwardedGitHubKey -KeyPath $ForwardedGitHubKeyPath
    Write-DotEnvFile -Path $tempEnvPath -Values $envValues
    Write-LfTextFile -Path $tempBootstrapPath -Content (Get-Content -Path (Join-Path $repoRoot "scripts\bootstrap-linux-server.sh") -Raw)

    Copy-ToRemote -LocalPath $tempBootstrapPath -RemotePath $bootstrapRemotePath
    Copy-ToRemote -LocalPath $tempEnvPath -RemotePath $envRemotePath

    $remoteBootstrap = @(
        "set -euo pipefail",
        "chmod +x $bootstrapRemotePath",
        "sudo --preserve-env=SSH_AUTH_SOCK bash $bootstrapRemotePath --maverick-repo $(Quote-BashString $MaverickRepoUrl) --netwise-repo $(Quote-BashString $NetwiseRepoUrl) --syncsonic-repo $(Quote-BashString $SyncSonicRepoUrl) --maverick-branch $(Quote-BashString $MaverickBranch) --netwise-branch $(Quote-BashString $NetwiseBranch) --syncsonic-branch $(Quote-BashString $SyncSonicBranch) --app-dir $(Quote-BashString $RemoteAppDir) --state-dir $(Quote-BashString $RemoteStateDir) --env-file $(Quote-BashString $envRemotePath) --service-name $(Quote-BashString $ServiceName)",
        "rm -f $bootstrapRemotePath $envRemotePath"
    ) -join " && "

    Invoke-SshCommand -Command $remoteBootstrap

    if (-not $SkipDatabaseSync) {
        & (Join-Path $repoRoot "scripts\sync-linux-state.ps1") `
            -SshHost $SshHost `
            -ServiceName $ServiceName `
            -RemoteStateDir $RemoteStateDir
    }

    Invoke-SshCommand -Command "set -euo pipefail && sudo systemctl restart $ServiceName && sleep 2 && curl --fail --silent http://127.0.0.1:3847/health"
}
finally {
    Stop-TransientSshAgent
    Remove-Item -LiteralPath $tempEnvPath -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $tempBootstrapPath -ErrorAction SilentlyContinue
}
