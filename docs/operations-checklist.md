# Checklist operacional

Revisão realizada em 18 de setembro de 2026.

## Verificações concluídas

- [x] Suíte automatizada: 29 testes aprovados.
- [x] Os três workflows passam pelo validador estrutural e podem ser importados pelo n8n.
- [x] O manifesto de exemplo contém exatamente nove PDFs em ordem.
- [x] PostgreSQL não publica porta no computador hospedeiro.
- [x] Dashboard exige login, sessão assinada e token CSRF nas alterações.
- [x] Confirmação de pagamento é transacional e idempotente.
- [x] Webhooks duplicados são descartados antes de responder ao cliente.
- [x] Lembretes e mensagens de saída podem recuperar trabalhos interrompidos.
- [x] Opt-out por `PARAR`, `SAIR` ou `CANCELAR` interrompe a automação.
- [x] Busca por dados pessoais do vídeo não encontrou a chave Pix nem o nome na configuração ou nos workflows. As únicas ocorrências ficam nos validadores que impedem sua inclusão.
- [x] `.env` e arquivos enviados em `materials/` ficam fora do Git.

## Verificações no computador de operação

- [ ] Instalar ou iniciar o Docker Desktop. Em 18/09/2026, `docker version` não estava disponível neste computador.
- [ ] Preencher `.env` com chave Pix, nome do recebedor e senhas próprias.
- [ ] Copiar a imagem e os nove PDFs para `materials/`, criar `materials/manifest.json` e validar os nomes.
- [ ] Executar `powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1`.
- [ ] Confirmar que PostgreSQL, Evolution API, n8n e dashboard estão saudáveis com `docker compose ps`.
- [ ] Abrir o Evolution Manager e conectar o número autorizado pelo QR Code.
- [ ] Importar os workflows e configurar o webhook da instância.
- [ ] Fazer uma compra de teste com outro número: oferta, imagem, nove PDFs e uma única mensagem Pix.
- [ ] Enviar uma imagem como comprovante e confirmar a venda no dashboard.
- [ ] Executar o smoke test documentado no README.
- [ ] Validar `PARAR` e confirmar que o contato não recebe novos lembretes.
- [ ] Fazer um backup e testar sua restauração antes do uso comercial.

## Critério para uso real

Use o sistema com clientes somente depois de concluir todos os itens da seção anterior. O operador deve usar um número de WhatsApp autorizado, manter o opt-out ativo e conferir o pagamento no banco antes de marcá-lo como pago.
