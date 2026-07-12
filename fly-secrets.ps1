# Push STONPOOL_* secrets to the fly api app from a local env file, rewriting the
# Postgres URL to the async driver the app expects. PowerShell port of fly-secrets.sh.
#
#   fly pg attach stonpool-db -a stonpool-api   # sets DATABASE_URL on the app
#   .\fly-secrets.ps1 [-EnvFile .env.fly] [-App stonpool-api]
param(
    [string]$EnvFile = ".env.fly",
    [string]$App = "stonpool-api"
)
$ErrorActionPreference = "Stop"

if (-not (Test-Path $EnvFile)) { Write-Error "missing $EnvFile"; exit 1 }

# fly pg attach exposes DATABASE_URL as postgres://; sqlalchemy[asyncio] needs postgresql+asyncpg://
$dbUrl = ""
try { $dbUrl = (fly ssh console -a $App -C "printenv DATABASE_URL" 2>$null | Out-String).Trim() } catch {}
$asyncUrl = ""
if ($dbUrl) {
    $asyncUrl = $dbUrl -replace "^postgresql://", "postgresql+asyncpg://" `
                       -replace "^postgres://", "postgresql+asyncpg://"
}

$args = @()
foreach ($line in Get-Content $EnvFile) {
    $line = $line.Trim()
    if ($line -eq "" -or $line.StartsWith("#")) { continue }
    $i = $line.IndexOf("=")
    if ($i -lt 1) { continue }
    $key = $line.Substring(0, $i)
    $val = $line.Substring($i + 1)
    if ($val -eq "") { continue }
    $args += "$key=$val"
}
if ($asyncUrl) { $args += "STONPOOL_DATABASE_URL=$asyncUrl" }

if ($args.Count -eq 0) { Write-Host "nothing to set"; exit 0 }
fly secrets set -a $App @args
