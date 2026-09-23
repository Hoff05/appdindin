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

function nodeExists(flow, name) {
  return flow.nodes.some((item) => item.name === name);
}

test('payment reminder workflow cancels pending rows without sending WhatsApp messages', async () => {
  const flow = await workflow('02-payment-followups.json');
  const cancel = node(flow, 'Cancel Payment Followups');
  node(flow, 'Followup Schedule');

  assert.equal(nodeExists(flow, 'Send Followup'), false);
  assert.equal(nodeExists(flow, 'Build Followup Message'), false);
  assert.equal(flow.nodes.some((item) => item.type === 'n8n-nodes-base.httpRequest'), false);
  assert.match(cancel.parameters.query, /UPDATE followups f/i);
  assert.match(cancel.parameters.query, /status IN \('pending', 'processing'\)/i);
  assert.match(cancel.parameters.query, /RETURNING f\.id/i);
  assert.doesNotMatch(cancel.parameters.query, /c\.state\s*<>\s*'awaiting_payment'/i);
  assert.doesNotMatch(JSON.stringify(flow), /Você conseguiu efetuar o pagamento\?|Oi Prof|honrar com o compromisso|Vi que você ainda não finalizou/);
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
  assert.match(build.parameters.jsCode, /ATIVIDADES 1º ANO\.pdf/);
  assert.match(build.parameters.jsCode, /ATIVIDADES 9º ANO\.pdf/);
  assert.match(build.parameters.jsCode, /Universo Pedagogico - Entrega\.pdf/);
  assert.match(build.parameters.jsCode, /sendKind: 'document'/);
  const send = node(flow, 'Send Outbox Message');
  assert.match(send.parameters.url, /sendMedia/);
  assert.match(send.parameters.body, /mediatype: 'document'/);
  assert.match(send.parameters.body, /mimetype: 'application\/pdf'/);
});

test('scheduled HTTP requests use the correct retry and credential model', async () => {
  for (const file of ['03-dashboard-outbox.json']) {
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

test('scheduled Postgres nodes have the sales database credential', async () => {
  for (const file of ['02-payment-followups.json', '03-dashboard-outbox.json', '04-mercado-pago-pix.json']) {
    const flow = await workflow(file);
    const postgresNodes = flow.nodes.filter((item) => item.type === 'n8n-nodes-base.postgres');
    assert.ok(postgresNodes.length > 0);
    for (const postgresNode of postgresNodes) {
      assert.equal(
        postgresNode.credentials?.postgres?.name,
        'Postgres - vendas',
        `${file} / ${postgresNode.name} precisa da credencial Postgres - vendas`,
      );
    }
  }
});

test('payment reminder workflow no longer checks Mercado Pago or sends reminders', async () => {
  const flow = await workflow('02-payment-followups.json');
  assert.equal(nodeExists(flow, 'Search Followup Mercado Pago Payment'), false);
  assert.equal(nodeExists(flow, 'Record Followup Mercado Pago Payment'), false);
  assert.equal(nodeExists(flow, 'Followup Payment Approved'), false);
  assert.equal(nodeExists(flow, 'Claim Due Followups'), false);
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
