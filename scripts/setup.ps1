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
    $DockerDesktopPath = 'C:\Program Files\Docker\Docker\resources\bin\docker.exe'
    if (Test-Path -LiteralPath $DockerDesktopPath) {
        $DockerExe = $DockerDesktopPath
    } else {
        throw 'Docker Desktop não foi encontrado. Instale e abra o Docker Desktop antes de executar este script novamente.'
    }
} else {
    $DockerExe = $DockerCommand.Source
}

& $DockerExe compose --env-file '.env' config --quiet
if ($LASTEXITCODE -ne 0) { throw 'A configuração do Docker Compose é inválida.' }

& $DockerExe compose --env-file '.env' up -d --build
if ($LASTEXITCODE -ne 0) { throw 'Não foi possível iniciar os serviços.' }

Write-Host ''
Write-Host 'Serviços iniciados:' -ForegroundColor Green
Write-Host 'n8n:              http://localhost:5678'
Write-Host 'Evolution Manager: http://localhost:8080/manager'
Write-Host 'Dashboard:         http://localhost:3000'
Write-Host ''
Write-Host 'Próximo passo: configure o proprietário do n8n, crie a credencial Postgres - vendas e execute scripts\import-workflows.ps1.'
