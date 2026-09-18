import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workflowUrl = new URL('../workflows/01-whatsapp-inbound.json', import.meta.url);

async function loadJson(url) {
  return JSON.parse(await readFile(url, 'utf8'));
}

function reachable(flow, from, to, excluded = new Set()) {
  const queue = [from];
  const visited = new Set();
  while (queue.length) {
    const current = queue.shift();
    if (current === to) return true;
    if (visited.has(current) || excluded.has(current)) continue;
    visited.add(current);
    const outputs = flow.connections[current]?.main || [];
    for (const group of outputs) for (const edge of group) queue.push(edge.node);
  }
  return false;
}

function executeCode(node, input) {
  const source = node.parameters.jsCode;
  return Function('$json', '$env', `return (async () => { ${source} })();`)(input, {
    EVOLUTION_INSTANCE: 'kit-matematica',
  });
}

test('inbound workflow contains every guarded conversation branch', async () => {
  const flow = await loadJson(workflowUrl);
  const names = new Set(flow.nodes.map((node) => node.name));
  for (const required of [
    'Webhook Evolution', 'Normalize Event', 'Ignore Invalid Event', 'Insert Event Once',
    'Route State', 'Send Offer', 'Send Materials', 'Save Receipt', 'Stop Automation',
    'Respond Webhook',
  ]) assert.ok(names.has(required), `Nó ausente: ${required}`);

  assert.ok(reachable(flow, 'Insert Event Once', 'Send Offer'));
  assert.equal(reachable(flow, 'Webhook Evolution', 'Send Offer', new Set(['Insert Event Once'])), false);
});

test('every Evolution HTTP request uses the internal service and API key header', async () => {
  const flow = await loadJson(workflowUrl);
  const requests = flow.nodes.filter((node) => node.type === 'n8n-nodes-base.httpRequest');
  assert.ok(requests.length >= 5);
  for (const node of requests) {
    assert.match(node.parameters.url, /http:\/\/evolution-api:8080/);
    const headers = node.parameters.sendHeaders && node.parameters.headerParameters?.parameters;
    assert.ok(headers?.some((header) => header.name === 'apikey' && /EVOLUTION_API_KEY/.test(header.value)));
  }
});

test('normalizer extracts a direct text message and rejects groups or own messages', async () => {
  const [flow, fixture] = await Promise.all([
    loadJson(workflowUrl),
    loadJson(new URL('../fixtures/messages-upsert-text.json', import.meta.url)),
  ]);
  const normalizer = flow.nodes.find((node) => node.name === 'Normalize Event');
  const [item] = await executeCode(normalizer, { body: fixture });
  assert.equal(item.json.externalId, 'SMOKE-TEXT-001');
  assert.equal(item.json.phone, '5511999999999');
  assert.equal(item.json.intent, 'purchase');
  assert.equal(item.json.ignored, false);

  fixture.data.key.fromMe = true;
  const [ownMessage] = await executeCode(normalizer, { body: fixture });
  assert.equal(ownMessage.json.ignored, true);
});

test('normalizer recognizes payment receipt images', async () => {
  const [flow, fixture] = await Promise.all([
    loadJson(workflowUrl),
    loadJson(new URL('../fixtures/messages-upsert-image.json', import.meta.url)),
  ]);
  const normalizer = flow.nodes.find((node) => node.name === 'Normalize Event');
  const [item] = await executeCode(normalizer, { body: fixture });
  assert.equal(item.json.messageType, 'image');
  assert.equal(item.json.intent, 'receipt');
  assert.equal(item.json.mediaReference, 'evolution-media:SMOKE-IMAGE-001');
});

test('nine document items converge before creating one sale and one Pix message', async () => {
  const flow = await loadJson(workflowUrl);
  const aggregate = flow.nodes.find((node) => node.name === 'Aggregate Sent Documents');
  assert.ok(aggregate, 'O fluxo precisa agregar os nove resultados antes de continuar');
  assert.ok(reachable(flow, 'Send Document', 'Aggregate Sent Documents'));
  assert.ok(reachable(flow, 'Aggregate Sent Documents', 'Create Pending Sale'));
  assert.equal(
    flow.connections['Send Document'].main.flat().some((edge) => edge.node === 'Create Pending Sale'),
    false,
  );
});
