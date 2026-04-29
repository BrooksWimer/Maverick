[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$SshHost,

    [int]$LocalPort = 3848,

    [int]$RemotePort = 3847
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Write-Host "Opening Maverick state tunnel: http://127.0.0.1:$LocalPort -> ${SshHost}:127.0.0.1:$RemotePort"
Write-Host "Leave this window running while Windows Maverick uses STATE_BACKEND=remote."

ssh -N -L "127.0.0.1:${LocalPort}:127.0.0.1:${RemotePort}" $SshHost
if ($LASTEXITCODE -ne 0) {
    throw "SSH tunnel failed with exit code $LASTEXITCODE"
}
