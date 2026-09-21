# Atendimento de vendas pelo WhatsApp com n8n

Este projeto conecta um número existente do WhatsApp por **QR Code**, conduz a venda do kit de matemática, envia nove PDFs, gera uma cobrança Pix pelo Mercado Pago, verifica pagamentos aprovados automaticamente e registra os resultados em um dashboard.

## Componentes

- Evolution API 2.3.7: conexão do WhatsApp por QR Code.
- n8n 2.39.7: conversa, envio dos materiais e lembretes.
- PostgreSQL 16: contatos, vendas, mensagens e auditoria.
- Dashboard: faturamento, vendas pagas, pendências e confirmação manual.

> A conexão por QR usa a implementação WhatsApp Web da Evolution API. Ela não é a API oficial da Meta e pode sofrer desconexões ou bloqueios. Use um número comercial dedicado, responda somente a pessoas que iniciaram a conversa e evite disparos em massa.

## Pré-requisitos

1. Windows 10 ou 11 com [Docker Desktop](https://www.docker.com/products/docker-desktop/) instalado e aberto.
2. Um número de WhatsApp dedicado para o atendimento.
3. A imagem da oferta e os nove PDFs, que podem ser escolhidos depois.

## Primeira instalação

Abra o PowerShell nesta pasta e execute:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\setup.ps1
```

O instalador preserva qualquer `.env` ou `materials\manifest.json` existente. Antes de ativar o fluxo, abra `.env` e preencha:

- `PIX_KEY`
- `PIX_KEY_TYPE`
- `PIX_RECEIVER_NAME`
- `PRODUCT_PRICE`
- `MERCADO_PAGO_ACCESS_TOKEN`
- `MERCADO_PAGO_MIN_AMOUNT`, se quiser mudar o mínimo de R$ 10,00

Troque também as senhas de exemplo. A senha inicial do dashboard no arquivo de exemplo é `troque-esta-senha`. O arquivo guarda somente o hash scrypt. Para usar outra senha, gere um novo hash com Node.js ou solicite a geração pelo script de configuração antes de expor o painel.

Endereços locais:

- n8n: `http://localhost:5678`
- Evolution Manager: `http://localhost:8080/manager`
- dashboard: `http://localhost:3000`

## Conectar o WhatsApp pelo QR Code

1. Abra `http://localhost:8080/manager`.
2. Entre usando a chave `EVOLUTION_API_KEY` do `.env`.
3. Crie a instância com o nome definido em `EVOLUTION_INSTANCE` (`kit-matematica` por padrão).
4. Escolha a conexão Baileys/WhatsApp Web e abra o QR Code.
5. No celular, abra WhatsApp → Aparelhos conectados → Conectar aparelho e leia o código.
6. Configure o webhook da instância como `http://n8n:5678/webhook/evolution/messages`.
7. Habilite o evento `MESSAGES_UPSERT`.

## Colocar a imagem e os PDFs

Copie `materials\manifest.example.json` para `materials\manifest.json`. Coloque na pasta `materials`:

- `oferta.jpg`
- `atividades-1-ano.pdf`
- `atividades-2-ano.pdf`
- os demais arquivos até `atividades-9-ano.pdf`

Você pode usar outros nomes. Ajuste `file` e `displayName` no `manifest.json`, mantendo as ordens de 1 a 9. O campo `driveUrl` é opcional.

Para validar antes de ativar:

```powershell
node .\scripts\validate-config.mjs .\materials\manifest.json
```

## Preparar o n8n

No primeiro acesso a `http://localhost:5678`, crie o proprietário local do n8n. Depois crie uma credencial PostgreSQL com o nome exato **Postgres - vendas**:

- Host: `postgres`
- Porta: `5432`
- Banco: valor de `POSTGRES_DB`
- Usuário: valor de `POSTGRES_USER`
- Senha: valor de `POSTGRES_PASSWORD`
- SSL: desativado na rede local do Compose

Importe os fluxos:

```powershell
.\scripts\import-workflows.ps1
```

Abra os quatro workflows, associe a credencial **Postgres - vendas** a todos os nós PostgreSQL, salve e ative na ordem:

1. `01 - WhatsApp - Atendimento e vendas`
2. `02 - WhatsApp - Lembretes de pagamento`
3. `03 - WhatsApp - Fila do dashboard`
4. `04 - Mercado Pago - Verificar Pix`

## Como funciona

O cliente escreve “quero o kit”. O bot apresenta a oferta e espera uma resposta afirmativa. Depois envia os nove PDFs, cria uma cobrança Pix no Mercado Pago, envia o QR Code/copia e cola e solicita o comprovante. O workflow `04 - Mercado Pago - Verificar Pix` consulta os pagamentos pendentes a cada minuto. Quando o pagamento volta como aprovado com valor igual ou maior que `MERCADO_PAGO_MIN_AMOUNT`, a venda é marcada como paga, os lembretes são cancelados e a liberação das outras atividades entra na fila de envio do WhatsApp.

O dashboard ainda permite confirmar manualmente um pagamento quando necessário. A ação é idempotente: clicar novamente não duplica a venda nem a mensagem.

As palavras `parar`, `cancelar`, `sair` ou `não quero` interrompem os lembretes. O dashboard também possui o botão **Parar mensagens**.

## Testes

Os testes locais de código não enviam mensagens reais:

```powershell
node --test tests\*.test.mjs automation\test\*.test.mjs dashboard\test\*.test.js
```

Com os contêineres ativos, o smoke test cria uma venda temporária, confirma pelo dashboard e remove somente seus próprios registros:

```powershell
docker compose --env-file .env exec -T dashboard node scripts/smoke-test.mjs
```

Se a senha do dashboard tiver sido alterada, defina `DASHBOARD_TEST_PASSWORD` apenas na sessão do PowerShell antes do teste.

## Operação

```powershell
docker compose --env-file .env up -d
docker compose --env-file .env ps
docker compose --env-file .env logs -f n8n evolution-api dashboard
docker compose --env-file .env stop
```

Para atualizar, faça um backup, altere somente versões verificadas no `compose.yaml` e execute `docker compose --env-file .env up -d --build`.

## Backup e restauração

Crie a pasta de backup e exporte o banco:

```powershell
New-Item -ItemType Directory -Force .\backup
docker compose --env-file .env exec -T postgres pg_dump -U zap_app -d zap_sales -Fc > .\backup\zap-sales.dump
```

Restaure em um banco vazio:

```powershell
Get-Content -AsByteStream .\backup\zap-sales.dump | docker compose --env-file .env exec -T postgres pg_restore -U zap_app -d zap_sales --clean --if-exists
```

Copie também os volumes `n8n_data` e `evolution_instances` antes de uma reinstalação completa.

## Acesso externo

O projeto publica portas apenas para uso local. Para acessar o dashboard ou n8n pela internet, coloque um proxy reverso com HTTPS e autenticação na frente dos serviços. Não exponha diretamente PostgreSQL, n8n ou Evolution API.

## Diagnóstico

- QR desconectou: abra o Evolution Manager e reconecte a instância.
- PDFs não enviam: valide `manifest.json` e confirme que os arquivos estão em `materials`.
- Workflow pede credencial: selecione **Postgres - vendas** no nó indicado e salve.
- Dashboard sem dados: confira `docker compose logs dashboard` e a saúde do PostgreSQL.
- Mensagens duplicadas: confirme que existe apenas uma cópia ativa de cada workflow no n8n.

