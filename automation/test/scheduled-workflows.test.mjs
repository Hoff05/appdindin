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

test('follow-up workflow cancels ineligible rows and safely claims due work', async () => {
  const flow = await workflow('02-payment-followups.json');
  const cancel = node(flow, 'Cancel Ineligible Followups');
  const claim = node(flow, 'Claim Due Followups');
  node(flow, 'Followup Schedule');
  node(flow, 'Build Followup Message');
  node(flow, 'Send Followup');
  node(flow, 'Mark Followup Sent');
  node(flow, 'Mark Followup Failed');

  assert.match(cancel.parameters.query, /c\.state\s*<>\s*'awaiting_payment'/i);
  assert.match(cancel.parameters.query, /s\.status\s*<>\s*'pending'/i);
  assert.match(claim.parameters.query, /FOR UPDATE SKIP LOCKED/i);
  assert.match(claim.parameters.query, /processing_started_at.*10 minutes/is);
  assert.match(claim.parameters.query, /LIMIT 20/i);
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
});

test('scheduled Evolution requests use retries and environment API keys', async () => {
  for (const file of ['02-payment-followups.json', '03-dashboard-outbox.json']) {
    const flow = await workflow(file);
    const requests = flow.nodes.filter((item) => item.type === 'n8n-nodes-base.httpRequest');
    assert.ok(requests.length > 0);
    for (const request of requests) {
      assert.equal(request.retryOnFail, true);
      assert.ok(request.maxTries >= 3);
      assert.match(request.parameters.url, /http:\/\/evolution-api:8080/);
      assert.ok(request.parameters.headerParameters.parameters.some(
        (header) => header.name === 'apikey' && /EVOLUTION_API_KEY/.test(header.value),
      ));
    }
  }
});

test('database schema records when asynchronous work was claimed', async () => {
  const schema = await readFile(new URL('../../database/init/001_schema.sql', import.meta.url), 'utf8');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS followups[\s\S]*processing_started_at TIMESTAMPTZ/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS outbox[\s\S]*processing_started_at TIMESTAMPTZ/);
});
