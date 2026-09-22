$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $ProjectRoot

$DockerCommand = Get-Command docker -ErrorAction SilentlyContinue
if (-not $DockerCommand) {
    $DockerDesktopPaths = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\resources\bin\docker.exe'),
        'C:\Program Files\Docker\Docker\resources\bin\docker.exe'
    )
    $DockerDesktopPath = $DockerDesktopPaths | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if (-not $DockerDesktopPath) { throw 'Docker Desktop não foi encontrado.' }
    $DockerExe = $DockerDesktopPath
} else {
    $DockerExe = $DockerCommand.Source
}

$DockerBin = Split-Path -Parent $DockerExe
if (($env:PATH -split ';') -notcontains $DockerBin) {
    $env:PATH = "$DockerBin;$env:PATH"
}

function Get-EnvValue([string]$Name, [string]$DefaultValue = '') {
    foreach ($Line in Get-Content -LiteralPath '.env') {
        if ($Line -match "^$([regex]::Escape($Name))=(.*)$") { return $Matches[1] }
    }
    return $DefaultValue
}

function ConvertTo-SqlLiteral([string]$Value) {
    return "'" + ($Value -replace "'", "''") + "'"
}

function Upsert-AppConfig {
    $Rows = @(
        @('evolution_instance', (Get-EnvValue 'EVOLUTION_INSTANCE' 'kit-matematica')),
        @('product_price', (Get-EnvValue 'PRODUCT_PRICE' '9.90')),
        @('pix_key', (Get-EnvValue 'PIX_KEY' '')),
        @('pix_key_type', (Get-EnvValue 'PIX_KEY_TYPE' 'telefone')),
        @('pix_receiver_name', (Get-EnvValue 'PIX_RECEIVER_NAME' '')),
        @('materials_drive_url', (Get-EnvValue 'MATERIALS_DRIVE_URL' '')),
        @('followup_minutes', (Get-EnvValue 'FOLLOWUP_MINUTES' '15,60,91')),
        @('payment_notify_phone', (Get-EnvValue 'PAYMENT_NOTIFY_PHONE' '')),
        @('mercado_pago_public_key', (Get-EnvValue 'MERCADO_PAGO_PUBLIC_KEY' '')),
        @('mercado_pago_access_token', (Get-EnvValue 'MERCADO_PAGO_ACCESS_TOKEN' '')),
        @('mercado_pago_client_id', (Get-EnvValue 'MERCADO_PAGO_CLIENT_ID' '')),
        @('mercado_pago_client_secret', (Get-EnvValue 'MERCADO_PAGO_CLIENT_SECRET' '')),
        @('mercado_pago_min_amount', (Get-EnvValue 'MERCADO_PAGO_MIN_AMOUNT' '10.00')),
        @('mercado_pago_amounts', (Get-EnvValue 'MERCADO_PAGO_AMOUNTS' '10.00,14.90,19.90,29.90,49.90')),
        @('evolution_go_base_url', (Get-EnvValue 'EVOLUTION_GO_BASE_URL' 'http://host.docker.internal:4000')),
        @('evolution_go_api_key', (Get-EnvValue 'EVOLUTION_GO_API_KEY' 'pix-go-test')),
        @('meta_whatsapp_phone_number_id', (Get-EnvValue 'META_WHATSAPP_PHONE_NUMBER_ID' '')),
        @('meta_whatsapp_access_token', (Get-EnvValue 'META_WHATSAPP_ACCESS_TOKEN' '')),
        @('meta_whatsapp_api_version', (Get-EnvValue 'META_WHATSAPP_API_VERSION' 'v21.0'))
    )

    $Values = ($Rows | ForEach-Object {
        '(' + (ConvertTo-SqlLiteral $_[0]) + ', ' + (ConvertTo-SqlLiteral $_[1]) + ')'
    }) -join ",`n"

    $Sql = @"
CREATE TABLE IF NOT EXISTS app_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO app_config (key, value)
VALUES
$Values
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();
"@

    $Sql | & $DockerExe compose --env-file '.env' exec -T postgres psql -U (Get-EnvValue 'POSTGRES_USER') -d (Get-EnvValue 'POSTGRES_DB')
    if ($LASTEXITCODE -ne 0) { throw 'Falha ao gravar app_config no Postgres.' }
}

function Import-EvolutionCredential {
    $ApiKey = Get-EnvValue 'EVOLUTION_API_KEY'
    if ([string]::IsNullOrWhiteSpace($ApiKey)) { throw 'EVOLUTION_API_KEY não está configurada no .env.' }

    $TempCredential = Join-Path ([System.IO.Path]::GetTempPath()) ('evolution-credential-' + [guid]::NewGuid().ToString('N') + '.json')
    try {
        $CredentialObject = @(
            @{
                id = 'evolutionApiKey'
                name = 'Evolution API - apikey'
                type = 'httpHeaderAuth'
                data = @{
                    name = 'apikey'
                    value = $ApiKey
                }
            }
        )
        $Credential = ConvertTo-Json -Depth 6 -InputObject $CredentialObject

        $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($TempCredential, $Credential, $Utf8NoBom)
        & $DockerExe compose --env-file '.env' cp $TempCredential n8n:/tmp/evolution-credential.json
        if ($LASTEXITCODE -ne 0) { throw 'Falha ao copiar credencial para o container n8n.' }

        & $DockerExe compose --env-file '.env' exec -T n8n n8n import:credentials --input=/tmp/evolution-credential.json --include=id,name,type,data
        if ($LASTEXITCODE -ne 0) { throw 'Falha ao importar credencial Evolution API - apikey.' }
    } finally {
        if (Test-Path -LiteralPath $TempCredential) { Remove-Item -LiteralPath $TempCredential -Force }
        & $DockerExe compose --env-file '.env' exec -T --user root n8n rm -f /tmp/evolution-credential.json | Out-Null
    }
}

Upsert-AppConfig
Import-EvolutionCredential

$WorkflowNames = @(
    '01-whatsapp-inbound.json',
    '02-payment-followups.json',
    '03-dashboard-outbox.json',
    '04-mercado-pago-pix.json'
)

foreach ($WorkflowName in $WorkflowNames) {
    Write-Host "Importando $WorkflowName..."
    & $DockerExe compose --env-file '.env' exec -T n8n n8n import:workflow --input="/workflows/$WorkflowName"
    if ($LASTEXITCODE -ne 0) { throw "Falha ao importar $WorkflowName." }
}

$WorkflowIds = @(
    'b0d43a70-f700-4a36-9b19-17cf35423901',
    'b0d43a70-f700-4a36-9b19-17cf35423902',
    'b0d43a70-f700-4a36-9b19-17cf35423903',
    'b0d43a70-f700-4a36-9b19-17cf35423904'
)

foreach ($WorkflowId in $WorkflowIds) {
    Write-Host "Ativando workflow $WorkflowId..."
    & $DockerExe compose --env-file '.env' exec -T n8n n8n update:workflow --id=$WorkflowId --active=true
    if ($LASTEXITCODE -ne 0) { throw "Falha ao ativar workflow $WorkflowId." }
}

Write-Host 'Reiniciando n8n para registrar os webhooks...'
& $DockerExe compose --env-file '.env' restart n8n
if ($LASTEXITCODE -ne 0) { throw 'Falha ao reiniciar o n8n.' }

Write-Host 'Workflows importados e ativados.' -ForegroundColor Green


