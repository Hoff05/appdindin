# Sistema de vendas pelo WhatsApp com n8n

## Objetivo

Criar um sistema local executado no Docker Desktop que conecte um número existente do WhatsApp por QR Code, automatize a oferta e a entrega de um kit de matemática, solicite pagamento por uma chave Pix fixa e registre o funil de vendas em um dashboard web.

O primeiro uso deve exigir apenas a configuração de senhas, da chave Pix e dos materiais. Credenciais e dados pessoais não serão versionados.

## Escopo

O sistema inclui:

- Evolution API para a conexão do WhatsApp por QR Code;
- n8n para receber eventos e executar o fluxo de mensagens;
- PostgreSQL como fonte única dos contatos, mensagens, estados e pagamentos;
- um dashboard web protegido por login;
- uma pasta configurável para imagem, PDFs e demais materiais;
- configuração por variáveis de ambiente;
- instruções de instalação, conexão e operação no Docker Desktop.

Não haverá confirmação bancária automática. Um pagamento será considerado concluído somente depois que o operador o confirmar no dashboard.

## Arquitetura

Um arquivo Docker Compose iniciará quatro serviços na mesma rede interna:

1. `postgres`: banco persistente com verificações de saúde e volume próprio.
2. `evolution-api`: sessão do WhatsApp conectada por QR Code e configurada para publicar eventos de mensagem no n8n.
3. `n8n`: automação persistente, com os materiais montados somente para leitura.
4. `dashboard`: aplicação web que lê e altera os registros de venda no PostgreSQL.

Somente as portas necessárias para o operador serão publicadas no computador. Serviços internos usarão nomes do Compose para se comunicar. Segredos serão fornecidos por `.env`, criado a partir de `.env.example`.

A Evolution API é uma integração baseada no WhatsApp Web e não é a API oficial da Meta. A documentação explicará o risco de desconexão ou bloqueio e recomendará um número comercial dedicado, uso moderado e atendimento apenas a contatos que iniciaram a conversa.

## Modelo de dados

### `contacts`

Armazena o identificador do WhatsApp, telefone normalizado, nome conhecido, estado atual do funil, consentimento, data do primeiro e do último contato e data do próximo lembrete.

Estados possíveis:

- `new`
- `offered`
- `awaiting_consent`
- `sending_materials`
- `awaiting_payment`
- `paid`
- `stopped`
- `failed`

### `message_events`

Registra o identificador exclusivo do evento, direção, tipo, conteúdo resumido e horário. A unicidade do identificador impede processamento duplicado quando um webhook é reenviado.

### `sales`

Registra o contato, valor esperado, valor confirmado, referência do comprovante, status, horário de criação, horário de confirmação e usuário que confirmou. Status possíveis: `pending`, `paid`, `unpaid` e `cancelled`.

### `followups`

Registra cada lembrete agendado e seu resultado. Isso impede envios repetidos e oferece rastreabilidade no dashboard.

### `audit_log`

Registra ações administrativas, como confirmação de pagamento, interrupção das mensagens e alteração manual do estado.

### `outbox`

Registra mensagens solicitadas pelo dashboard, como o agradecimento após a confirmação. O n8n consome essa fila com idempotência e grava o resultado de cada envio.

## Fluxo de mensagens

O webhook de entrada normaliza o evento e descarta mensagens de grupos, eventos sem conteúdo, mensagens enviadas pelo próprio número e eventos já processados.

Uma primeira mensagem com intenção de compra, incluindo termos como `kit`, `matemática`, `comprar`, `quero` ou a frase predefinida do anúncio, cria ou atualiza o contato. O sistema então envia, com pequenos intervalos:

1. saudação e apresentação;
2. pedido para salvar o contato;
3. imagem e descrição da oferta;
4. itens incluídos e preço padrão de R$ 9,90;
5. explicação de que o material será entregue antes do pagamento;
6. pergunta solicitando confirmação para o envio.

Respostas afirmativas levam o contato para `sending_materials`. O fluxo lê o manifesto da pasta de materiais, envia os nove PDFs na ordem configurada e, quando configurado, envia também um link alternativo. Depois apresenta os valores de contribuição, a chave Pix e a solicitação do comprovante. A venda passa para `pending` e o contato para `awaiting_payment`.

Respostas negativas ou palavras como `parar`, `cancelar`, `sair` e `não quero` movem o contato para `stopped`. Esse estado bloqueia novos envios automáticos.

Mensagens comuns durante o atendimento recebem uma resposta curta conforme o estado. Mensagens não reconhecidas são registradas e recebem orientação para falar com uma pessoa, sem reiniciar o funil.

## Lembretes

Um fluxo agendado procura contatos em `awaiting_payment`. Cada contato pode receber no máximo três lembretes:

- 15 minutos depois do envio dos materiais;
- 2 horas depois;
- 24 horas depois.

Antes de cada envio, o fluxo consulta novamente o contato e a venda. Ele cancela o lembrete se o pagamento foi confirmado, se o contato pediu para parar ou se houve uma resposta posterior que exige atendimento humano.

## Dashboard

O dashboard terá autenticação por sessão com usuário e senha definidos no ambiente. Senhas serão armazenadas como hash e cookies serão `HttpOnly` e `SameSite=Lax`.

A página inicial mostrará:

- faturamento confirmado no período;
- quantidade de vendas pagas;
- pagamentos pendentes;
- novos contatos;
- gráfico de vendas e faturamento por dia;
- tabela pesquisável com contato, telefone, etapa, valor e datas.

A tela de detalhes mostrará o histórico do contato e permitirá:

- confirmar o pagamento e informar o valor efetivamente recebido;
- marcar a venda como não paga;
- parar ou reativar mensagens;
- abrir a conversa pelo link `wa.me`.

Confirmar o pagamento será uma transação no banco: atualiza a venda, muda o contato para `paid`, cancela lembretes pendentes, grava auditoria e cria uma tarefa de agradecimento para o n8n enviar. Cliques repetidos serão idempotentes.

## Materiais e configuração

A pasta `materiais/` terá um manifesto de exemplo. O usuário poderá escolher os arquivos depois, sem alterar o fluxo. O manifesto conterá o nome exibido, o caminho local e a ordem de cada item.

O sistema não usará a chave Pix, o telefone ou o link do Drive vistos na gravação. Esses dados serão preenchidos pelo usuário em `.env` e no manifesto, evitando copiar dados de terceiros do vídeo.

Variáveis configuráveis incluirão:

- chave, tipo e nome do recebedor Pix;
- preço padrão;
- textos principais;
- link alternativo dos materiais;
- credenciais do dashboard e dos serviços;
- fuso horário;
- intervalos e limite dos lembretes.

## Tratamento de erros

- Webhooks duplicados retornarão sucesso sem repetir ações.
- Falhas temporárias da Evolution API terão novas tentativas com espera crescente.
- Falha no envio de um PDF manterá o contato em `sending_materials`, registrará o item com erro e permitirá reprocessamento seguro.
- Arquivos ausentes serão detectados por uma validação de configuração antes da ativação do fluxo.
- O n8n não marcará uma venda como paga ao receber apenas uma imagem; o comprovante ficará associado ao contato para análise manual.
- Consultas e mutações do dashboard usarão parâmetros, validação de entrada e transações.
- Logs não exibirão senhas, tokens ou o conteúdo binário dos comprovantes.

## Segurança e operação

O dashboard e o n8n serão destinados a acesso local. Para acesso externo, a documentação exigirá HTTPS e um túnel ou proxy reverso configurado pelo operador. O Compose terá uma chave de criptografia fixa do n8n e senhas próprias para PostgreSQL e Evolution API.

Volumes persistentes preservarão banco, credenciais e fluxos após reinicializações. Haverá comandos documentados para iniciar, parar, atualizar e fazer backup.

## Verificação

A entrega será validada por:

- validação sintática do Docker Compose e dos arquivos JSON do n8n;
- testes do banco para transições de estado e idempotência;
- testes do dashboard para login, filtros e confirmação de pagamento;
- teste do fluxo com eventos simulados de mensagem, resposta afirmativa, recusa, comprovante e webhook duplicado;
- teste de cancelamento de lembretes após pagamento e opt-out;
- verificação manual de inicialização dos contêineres quando o Docker Desktop estiver disponível.

## Critérios de conclusão

O sistema estará pronto quando o operador puder iniciar os serviços, conectar o WhatsApp pelo QR Code, colocar seus próprios materiais na pasta, importar ou ativar os fluxos, percorrer o funil com um número de teste, confirmar o pagamento no dashboard e ver os indicadores atualizados sem duplicações.
