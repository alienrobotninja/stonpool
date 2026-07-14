# Push STONPOOL_* secrets to the fly api app from a local env file.
#
#   .\fly-secrets.ps1 [-EnvFile .env.fly] [-App stonpool-api]
param(
    [string]$EnvFile = ".env.fly",
    [string]$App = "stonpool-api"
)
$ErrorActionPreference = "Stop"

if (-not (Test-Path $EnvFile)) { Write-Error "missing $EnvFile"; exit 1 }

$secretArgs = @()
foreach ($line in Get-Content $EnvFile) {
    $line = $line.Trim()
    if ($line -eq "" -or $line.StartsWith("#")) { continue }
    $i = $line.IndexOf("=")
    if ($i -lt 1) { continue }
    $key = $line.Substring(0, $i)
    $val = $line.Substring($i + 1)
    if ($val -eq "" -or $val -match '^<[A-Z_-]+>$') { continue }  # skip unfilled placeholders
    $secretArgs += "$key=$val"
}

if ($secretArgs.Count -eq 0) { Write-Host "nothing to set"; exit 0 }
fly secrets set -a $App @secretArgs