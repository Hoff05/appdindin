$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $ProjectRoot

$DockerCommand = Get-Command docker -ErrorAction SilentlyContinue
if (-not $DockerCommand) {
    $DockerDesktopPath = 'C:\Program Files\Docker\Docker\resources\bin\docker.exe'
    if (-not (Test-Path -LiteralPath $DockerDesktopPath)) { throw 'Docker Desktop não foi encontrado.' }
    $DockerExe = $DockerDesktopPath
} else {
    $DockerExe = $DockerCommand.Source
}

$WorkflowNames = @(
    '01-whatsapp-inbound.json',
    '02-payment-followups.json',
    '03-dashboard-outbox.json'
)

foreach ($WorkflowName in $WorkflowNames) {
    Write-Host "Importando $WorkflowName..."
    & $DockerExe compose --env-file '.env' exec -T n8n n8n import:workflow --input="/workflows/$WorkflowName"
    if ($LASTEXITCODE -ne 0) { throw "Falha ao importar $WorkflowName." }
}

Write-Host 'Workflows importados. Abra o n8n, associe a credencial Postgres - vendas aos nós PostgreSQL e ative os três fluxos.' -ForegroundColor Green
