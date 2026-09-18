$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $ProjectRoot

if (Test-Path -LiteralPath '.env') {
    Write-Host '.env já existe; mantendo a configuração existente.' -ForegroundColor Yellow
} else {
    Copy-Item -LiteralPath '.env.example' -Destination '.env'
    Write-Host 'Arquivo .env criado. Preencha a chave Pix e altere as senhas de exemplo.' -ForegroundColor Yellow
}

if (Test-Path -LiteralPath 'materials\manifest.json') {
    Write-Host 'manifest.json já existe; mantendo a seleção atual de materiais.' -ForegroundColor Yellow
} else {
    Copy-Item -LiteralPath 'materials\manifest.example.json' -Destination 'materials\manifest.json'
    Write-Host 'Manifesto criado em materials\manifest.json.'
}

$DockerCommand = Get-Command docker -ErrorAction SilentlyContinue
if (-not $DockerCommand) {
    $DockerDesktopPaths = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\resources\bin\docker.exe'),
        'C:\Program Files\Docker\Docker\resources\bin\docker.exe'
    )
    $DockerDesktopPath = $DockerDesktopPaths | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if ($DockerDesktopPath) {
        $DockerExe = $DockerDesktopPath
    } else {
        throw 'Docker Desktop não foi encontrado. Instale e abra o Docker Desktop antes de executar este script novamente.'
    }
} else {
    $DockerExe = $DockerCommand.Source
}

$DockerBin = Split-Path -Parent $DockerExe
if (($env:PATH -split ';') -notcontains $DockerBin) {
    $env:PATH = "$DockerBin;$env:PATH"
}

& $DockerExe compose --env-file '.env' config --quiet
if ($LASTEXITCODE -ne 0) { throw 'A configuração do Docker Compose é inválida.' }

& $DockerExe compose --env-file '.env' up -d --build
if ($LASTEXITCODE -ne 0) { throw 'Não foi possível iniciar os serviços.' }

function Get-EnvValue([string]$Name, [string]$DefaultValue) {
    foreach ($Line in Get-Content -LiteralPath '.env') {
        if ($Line -match "^$([regex]::Escape($Name))=(.*)$") { return $Matches[1] }
    }
    return $DefaultValue
}

$N8nPort = Get-EnvValue 'N8N_PORT' '5678'
$EvolutionPort = Get-EnvValue 'EVOLUTION_PORT' '8080'
$DashboardPort = Get-EnvValue 'DASHBOARD_PORT' '3000'

Write-Host ''
Write-Host 'Serviços iniciados:' -ForegroundColor Green
Write-Host "n8n:               http://localhost:$N8nPort"
Write-Host "Evolution Manager: http://localhost:$EvolutionPort/manager"
Write-Host "Dashboard:         http://localhost:$DashboardPort"
Write-Host ''
Write-Host 'Próximo passo: configure o proprietário do n8n, crie a credencial Postgres - vendas e execute scripts\import-workflows.ps1.'
