# Dot-source this script so the connection variable stays in your current shell.
$ErrorActionPreference = 'Stop'
$commerceProject = Split-Path -Parent $PSScriptRoot
$commerceNode = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $commerceNode) {
  $commerceNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
}
& $commerceNode (Join-Path $PSScriptRoot 'ecommerce-local.mjs') start
if ($LASTEXITCODE -ne 0) { throw 'Cannot start the isolated commerce test database' }
$commerceConnection = Get-Content -LiteralPath (Join-Path $commerceProject 'data\ecommerce-local\connection.json') -Raw | ConvertFrom-Json
$env:MINICLAW_ECOMMERCE_TEST_URL = $commerceConnection.url
Write-Output 'Test database configured for this shell. Run npm run dev:all in this shell to use the ecommerce page.'
