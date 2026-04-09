[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$SshHost,

    [string]$ServiceName = "maverick",

    [string]$RemoteStateDir = "/var/lib/maverick",

    [string]$LocalDatabasePath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (-not $LocalDatabasePath) {
    $LocalDatabasePath = Join-Path $repoRoot "data\orchestrator.db"
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

    Invoke-NativeCommand -FilePath "ssh" -Arguments @($SshHost, "bash", "-lc", (Quote-BashString -Value $Command))
}

function Copy-ToRemote {
    param(
        [Parameter(Mandatory = $true)]
        [string]$LocalPath,

        [Parameter(Mandatory = $true)]
        [string]$RemotePath
    )

    Invoke-NativeCommand -FilePath "scp" -Arguments @($LocalPath, "${SshHost}:${RemotePath}")
}

$runningLocalMaverick = Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -and $_.CommandLine -like "*Maverick*" -and ($_.CommandLine -like "*node*" -or $_.CommandLine -like "*tsx*")
}

if ($runningLocalMaverick) {
    throw "Stop local Maverick processes before syncing the SQLite state."
}

$dbFiles = @($LocalDatabasePath, "$LocalDatabasePath-wal", "$LocalDatabasePath-shm") | Where-Object { Test-Path $_ }
if (-not (Test-Path $LocalDatabasePath)) {
    throw "Database file not found: $LocalDatabasePath"
}

$remoteTempDir = "/tmp/maverick-state"
Invoke-SshCommand -Command "set -euo pipefail && mkdir -p $remoteTempDir && (sudo systemctl stop $ServiceName >/dev/null 2>&1 || true)"

foreach ($file in $dbFiles) {
    $remoteTarget = "$remoteTempDir/$([System.IO.Path]::GetFileName($file))"
    Copy-ToRemote -LocalPath $file -RemotePath $remoteTarget
}

$installCommand = @(
    "set -euo pipefail",
    "sudo install -d -o maverick -g maverick -m 0755 $RemoteStateDir",
    "for file in orchestrator.db orchestrator.db-wal orchestrator.db-shm; do if [ -f $remoteTempDir/\$file ]; then sudo install -o maverick -g maverick -m 0640 $remoteTempDir/\$file $RemoteStateDir/\$file; fi; done",
    "rm -rf $remoteTempDir"
) -join " && "

Invoke-SshCommand -Command $installCommand
