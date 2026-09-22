import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function workflow(name) {
  return JSON.parse(await readFile(new URL(`../workflows/${name}`, import.meta.url), 'utf8'));
}

function node(flow, name) {
  const found = flow.nodes.find((item) => item.name === name);
  assert.ok(found, `Nó ausente: ${name}`);
  return found;
}

function executeCode(node, items) {
  const source = node.parameters.jsCode;
  return Function('$input', `return (async () => { ${source} })();`)({
    all: () => items,
  });
}

test('follow-up workflow cancels ineligible rows and safely claims due work', async () => {
  const flow = await workflow('02-payment-followups.json');
  const cancel = node(flow, 'Cancel Ineligible Followups');
  const claim = node(flow, 'Claim Due Followups');
  node(flow, 'Followup Schedule');
  node(flow, 'Build Followup Message');
  node(flow, 'Search Followup Mercado Pago Payment');
  node(flow, 'Record Followup Mercado Pago Payment');
  node(flow, 'Followup Payment Approved');
  node(flow, 'Send Followup');
  node(flow, 'Mark Followup Sent');
  node(flow, 'Mark Followup Failed');

  assert.match(cancel.parameters.query, /c\.state\s*<>\s*'awaiting_payment'/i);
  assert.match(cancel.parameters.query, /s\.status\s*<>\s*'pending'/i);
  assert.match(claim.parameters.query, /FOR UPDATE SKIP LOCKED/i);
  assert.match(claim.parameters.query, /processing_started_at.*10 minutes/is);
  assert.match(claim.parameters.query, /LIMIT 20/i);
  assert.match(claim.parameters.query, /mercado_pago_access_token/i);
  assert.match(claim.parameters.query, /mercado_pago_external_reference/i);
  assert.match(claim.parameters.query, /mercado_pago_min_amount/i);
  assert.match(claim.parameters.query, /payment_notify_phone/i);
});

test('outbox workflow claims stale work and sends payment thanks once', async () => {
  const flow = await workflow('03-dashboard-outbox.json');
  const claim = node(flow, 'Claim Dashboard Outbox');
  const build = node(flow, 'Build Outbox Message');
  node(flow, 'Send Outbox Message');
  node(flow, 'Mark Outbox Sent');
  node(flow, 'Mark Outbox Failed');

  assert.match(claim.parameters.query, /FOR UPDATE SKIP LOCKED/i);
  assert.match(claim.parameters.query, /processing_started_at.*10 minutes/is);
  assert.match(build.parameters.jsCode, /payment_thanks/);
  assert.match(build.parameters.jsCode, /payment_release_approved/);
  assert.match(build.parameters.jsCode, /payment_release_instructions/);
  assert.match(build.parameters.jsCode, /payment_release_pdf/);
  assert.match(build.parameters.jsCode, /payment_admin_notify/);
  assert.match(build.parameters.jsCode, /Pagamento aprovado/);
  assert.match(build.parameters.jsCode, /Compra confirmada, amiga/);
  assert.match(build.parameters.jsCode, /Universo Pedagogico - Entrega\.pdf/);
  assert.match(build.parameters.jsCode, /sendKind: 'document'/);
  const send = node(flow, 'Send Outbox Message');
  assert.match(send.parameters.url, /sendMedia/);
  assert.match(send.parameters.body, /mediatype: 'document'/);
  assert.match(send.parameters.body, /mimetype: 'application\/pdf'/);
});

test('scheduled HTTP requests use the correct retry and credential model', async () => {
  for (const file of ['02-payment-followups.json', '03-dashboard-outbox.json']) {
    const flow = await workflow(file);
    const requests = flow.nodes.filter((item) => item.type === 'n8n-nodes-base.httpRequest');
    assert.ok(requests.length > 0);
    for (const request of requests) {
      assert.equal(request.retryOnFail, true);
      assert.ok(request.maxTries >= 3);
      const url = String(request.parameters.url);
      if (url.includes('api.mercadopago.com')) {
        assert.match(url, /api\.mercadopago\.com\/v1\/payments/);
        assert.match(JSON.stringify(request.parameters.headerParameters), /Authorization/);
      } else {
        assert.match(url, /http:\/\/evolution-api:8080/);
        assert.equal(request.parameters.authentication, 'genericCredentialType');
        assert.equal(request.parameters.genericAuthType, 'httpHeaderAuth');
        assert.equal(request.credentials?.httpHeaderAuth?.name, 'Evolution API - apikey');
      }
    }
  }
});

test('follow-up messages match the video payment reminder sequence', async () => {
  const flow = await workflow('02-payment-followups.json');
  const build = node(flow, 'Build Followup Message');

  const first = await executeCode(build, [{ json: { sequence: 1, displayName: 'Vicenzo' } }]);
  assert.deepEqual(first.map((item) => item.json.text), [
    'Você conseguiu efetuar o pagamento?',
  ]);

  const second = await executeCode(build, [{ json: { sequence: 2, displayName: 'Vicenzo' } }]);
  assert.deepEqual(second.map((item) => item.json.text), [
    'Oi Prof, deu certo o pagamento?',
  ]);

  const third = await executeCode(build, [{ json: { sequence: 3, displayName: 'Vicenzo' } }]);
  assert.deepEqual(third.map((item) => item.json.text), [
    'Oi Prof!',
    'Vi que você ainda não finalizou...',
    'Você consegue honrar com o compromisso que fizemos no começo da conversa?',
  ]);

  const fourth = await executeCode(build, [{ json: { sequence: 4 } }]);
  assert.deepEqual(fourth.map((item) => item.json.text), [
    'Vi que você ainda não finalizou seu acesso...',
    'Consigo contar com você para honrar o compromisso que combinamos no início da conversa? ✨',
    'Separei o material, organizei tudo com carinho e deixei seu acesso disponível 🎉',
  ]);

  const fifth = await executeCode(build, [{ json: { sequence: 5 } }]);
  assert.deepEqual(fifth.map((item) => item.json.text), [
    'Estou te chamando porque fiquei aguardando seu retorno e até agora você não respondeu...',
    'Desde o início da conversa deixei o material separado e enviei todas as informações com confiança 😌',
    'Então preciso apenas que você me confirme se realmente vai finalizar ou não 💗',
  ]);

  const sixth = await executeCode(build, [{ json: { sequence: 6 } }]);
  assert.deepEqual(sixth.map((item) => item.json.text), [
    'Prof, consegue me dar só um ok? 😔',
    'Como você tinha demonstrado interesse no material, deixei tudo reservado pra você ✨',
  ]);

  const seventh = await executeCode(build, [{ json: { sequence: 7 } }]);
  assert.deepEqual(seventh.map((item) => item.json.text), [
    'Oi, Prof! Vou ser direta com você 😔',
    'Talvez você esteja esperando ter todo o valor pra comprar... mas não precisa...',
    'Você pode contribuir com o que tiver hoje:',
    'R$6, R$5, R$4...',
    'Assim que finalizar, me manda o comprovante que já te entrego o acesso 👍',
  ]);
});

test('follow-up workflow checks Mercado Pago before sending each reminder', async () => {
  const flow = await workflow('02-payment-followups.json');
  const claim = node(flow, 'Claim Due Followups');
  const search = node(flow, 'Search Followup Mercado Pago Payment');
  const record = node(flow, 'Record Followup Mercado Pago Payment');
  const branch = node(flow, 'Followup Payment Approved');

  assert.match(search.parameters.url, /api\.mercadopago\.com\/v1\/payments\/search/);
  assert.match(search.parameters.url, /external_reference/);
  assert.equal(search.onError, 'continueRegularOutput');
  assert.match(record.parameters.query, /status = CASE WHEN i\.mp_status = 'approved'/);
  assert.match(record.parameters.query, /cancelled_followups/);
  assert.match(record.parameters.query, /payment_release_approved/);
  assert.match(record.parameters.query, /payment_release_instructions/);
  assert.match(record.parameters.query, /payment_release_pdf/);
  assert.match(record.parameters.options.queryReplacement, /Search Followup Mercado Pago Payment|Claim Due Followups/);
  assert.match(JSON.stringify(branch.parameters.conditions), /approved/);
  assert.match(claim.parameters.query, /JOIN sales s ON s\.id = claimed\.sale_id/);
});

test('Mercado Pago workflow polls approved Pix and queues material release', async () => {
  const flow = await workflow('04-mercado-pago-pix.json');
  const claim = node(flow, 'Claim Mercado Pago Payments');
  const getPayment = node(flow, 'Search Mercado Pago Payments');
  const record = node(flow, 'Record Mercado Pago Payment');

  assert.match(claim.parameters.query, /mercado_pago_access_token/);
  assert.match(claim.parameters.query, /mercado_pago_min_amount/);
  assert.match(claim.parameters.query, /FOR UPDATE SKIP LOCKED/i);
  assert.match(getPayment.parameters.url, /api\.mercadopago\.com\/v1\/payments/);
  assert.match(JSON.stringify(getPayment.parameters.headerParameters), /Authorization/);
  assert.match(record.parameters.query, /mp_status = 'approved'/);
  assert.match(record.parameters.query, /paid_amount >= i\.min_amount/);
  assert.match(record.parameters.query, /payment_release_approved/);
  assert.match(record.parameters.query, /payment_release_instructions/);
  assert.match(record.parameters.query, /payment_release_pdf/);
  assert.match(record.parameters.query, /payment_admin_notify/);
  assert.match(record.parameters.query, /mp-release:' \|\| u\.id \|\| ':' \|\| step\.step/);
});

test('database schema records when asynchronous work was claimed', async () => {
  const schema = await readFile(new URL('../../database/init/001_schema.sql', import.meta.url), 'utf8');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS followups[\s\S]*processing_started_at TIMESTAMPTZ/);
  assert.match(schema, /sequence_number SMALLINT NOT NULL CHECK \(sequence_number BETWEEN 1 AND 7\)/);
  assert.match(schema, /UNIQUE \(sale_id, sequence_number\)/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS outbox[\s\S]*processing_started_at TIMESTAMPTZ/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS app_config[\s\S]*key TEXT PRIMARY KEY/);
  assert.match(schema, /mercado_pago_payment_id TEXT/);
  assert.match(schema, /mercado_pago_preference_id TEXT/);
  assert.match(schema, /mercado_pago_payment_link TEXT/);
  assert.match(schema, /mercado_pago_payment_options JSONB/);
  assert.match(schema, /sales_mercado_pago_payment_idx/);
});



