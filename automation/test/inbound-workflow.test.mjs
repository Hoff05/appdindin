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

function executeRouteState(node, input) {
  const source = node.parameters.jsCode;
  return Function('$json', `return (async () => { ${source} })();`)(input);
}

test('inbound workflow contains every guarded conversation branch', async () => {
  const flow = await loadJson(workflowUrl);
  const webhook = flow.nodes.find((node) => node.name === 'Webhook Evolution');
  const names = new Set(flow.nodes.map((node) => node.name));
  for (const required of [
    'Webhook Evolution', 'Normalize Event', 'Ignore Invalid Event', 'Insert Event Once',
    'Route State', 'Send Offer', 'Send Materials', 'Save Receipt', 'Stop Automation',
    'Send Materials Intro', 'Send Consent Reaction', 'Respond Webhook',
  ]) assert.ok(names.has(required), `Nó ausente: ${required}`);

  assert.ok(reachable(flow, 'Insert Event Once', 'Send Offer'));
  assert.equal(reachable(flow, 'Webhook Evolution', 'Send Offer', new Set(['Insert Event Once'])), false);
  assert.match(webhook.webhookId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});

test('every Evolution HTTP request uses the internal service and n8n credential', async () => {
  const flow = await loadJson(workflowUrl);
  const requests = flow.nodes.filter((node) => node.type === 'n8n-nodes-base.httpRequest');
  assert.ok(requests.length >= 5);
  for (const node of requests) {
    assert.match(node.parameters.url, /http:\/\/evolution-api:8080/);
    assert.equal(node.parameters.authentication, 'genericCredentialType');
    assert.equal(node.parameters.genericAuthType, 'httpHeaderAuth');
    assert.equal(node.credentials?.httpHeaderAuth?.name, 'Evolution API - apikey');
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

test('normalizer recognizes stop phrases inside longer messages', async () => {
  const [flow, fixture] = await Promise.all([
    loadJson(workflowUrl),
    loadJson(new URL('../fixtures/messages-upsert-text.json', import.meta.url)),
  ]);
  fixture.data.message.conversation = 'PARAR poxa';

  const normalizer = flow.nodes.find((node) => node.name === 'Normalize Event');
  const [item] = await executeCode(normalizer, { body: fixture });

  assert.equal(item.json.intent, 'stop');
});

test('normalizer only starts the sales script for kit purchase phrases', async () => {
  const [flow, fixture] = await Promise.all([
    loadJson(workflowUrl),
    loadJson(new URL('../fixtures/messages-upsert-text.json', import.meta.url)),
  ]);
  const normalizer = flow.nodes.find((node) => node.name === 'Normalize Event');

  fixture.data.message.conversation = 'bom dia';
  const [greeting] = await executeCode(normalizer, { body: fixture });
  assert.equal(greeting.json.intent, 'other');

  fixture.data.message.conversation = 'Olá! Gostaria de adquirir o kit de Matemática.';
  const [purchase] = await executeCode(normalizer, { body: fixture });
  assert.equal(purchase.json.intent, 'purchase');
});

test('the video script stays quiet outside triggers and sends materials after trust reply', async () => {
  const flow = await loadJson(workflowUrl);
  const routeState = flow.nodes.find((node) => node.name === 'Route State');

  const [greeting] = await executeRouteState(routeState, {
    inserted: true,
    state: 'new',
    intent: 'other',
  });
  assert.equal(greeting.json.route, 'duplicate');

  const [bareAffirmative] = await executeRouteState(routeState, {
    inserted: true,
    state: 'new',
    intent: 'affirmative',
  });
  assert.equal(bareAffirmative.json.route, 'duplicate');

  const [negativeTrustReply] = await executeRouteState(routeState, {
    inserted: true,
    state: 'awaiting_consent',
    intent: 'negative',
  });
  assert.equal(negativeTrustReply.json.route, 'materials');

  const [unclearTrustReply] = await executeRouteState(routeState, {
    inserted: true,
    state: 'awaiting_consent',
    intent: 'other',
  });
  assert.equal(unclearTrustReply.json.route, 'materials');
});

test('stopped contacts stay silent unless they ask to buy again', async () => {
  const flow = await loadJson(workflowUrl);
  const routeState = flow.nodes.find((node) => node.name === 'Route State');

  const [ordinary] = await executeRouteState(routeState, {
    inserted: true,
    state: 'stopped',
    intent: 'other',
  });
  assert.equal(ordinary.json.route, 'duplicate');

  const [restart] = await executeRouteState(routeState, {
    inserted: true,
    state: 'stopped',
    intent: 'purchase',
  });
  assert.equal(restart.json.route, 'offer');
});

test('consent replies receive a WhatsApp reaction before materials are sent', async () => {
  const flow = await loadJson(workflowUrl);
  const reaction = flow.nodes.find((node) => node.name === 'Send Consent Reaction');

  assert.ok(reaction, 'O fluxo precisa reagir à resposta de confiança do cliente');
  assert.match(reaction.parameters.url, /\/message\/sendReaction\//);
  assert.match(reaction.parameters.url, /\$\('Route State'\)\.item\.json\.evolutionInstance/);
  assert.match(reaction.parameters.body, /reaction:\s*'👏'/);
  assert.match(reaction.parameters.body, /externalId/);
  assert.equal(reaction.onError, 'continueRegularOutput');
  assert.ok(reachable(flow, 'Mark Sending Materials', 'Send Consent Reaction'));
  assert.ok(reachable(flow, 'Send Consent Reaction', 'Send Materials Intro'));
});


test('normalizer ignores WhatsApp reaction events emitted by the bot reaction', async () => {
  const [flow, fixture] = await Promise.all([
    loadJson(workflowUrl),
    loadJson(new URL('../fixtures/messages-upsert-text.json', import.meta.url)),
  ]);
  fixture.data.key.id = 'SMOKE-REACTION-001';
  fixture.data.messageType = 'reactionMessage';
  fixture.data.message = {
    reactionMessage: {
      text: '👏',
      key: { id: 'ORIGINAL-MESSAGE-001', remoteJid: fixture.data.key.remoteJid, fromMe: false },
    },
  };

  const normalizer = flow.nodes.find((node) => node.name === 'Normalize Event');
  const [item] = await executeCode(normalizer, { body: fixture });

  assert.equal(item.json.ignored, true);
  assert.equal(item.json.messageType, 'reaction');
});
test('video timing waits two minutes before offer details and one minute before materials and Pix', async () => {
  const flow = await loadJson(workflowUrl);
  const offerWait = flow.nodes.find((node) => node.name === 'Offer Wait');
  const materialsWait = flow.nodes.find((node) => node.name === 'Materials Wait');
  const pixWait = flow.nodes.find((node) => node.name === 'Pix Wait');
  const insert = flow.nodes.find((node) => node.name === 'Insert Event Once');
  const createSale = flow.nodes.find((node) => node.name === 'Create Pending Sale');

  assert.equal(offerWait?.parameters.amount, 2);
  assert.equal(offerWait?.parameters.unit, 'minutes');
  assert.equal(materialsWait?.parameters.amount, 1);
  assert.equal(materialsWait?.parameters.unit, 'minutes');
  assert.equal(pixWait?.parameters.amount, 1);
  assert.equal(pixWait?.parameters.unit, 'minutes');
  assert.match(insert.parameters.query, /'15,60,91'/);
  assert.match(createSale.parameters.options.queryReplacement, /'15,60,91'/);
  assert.ok(reachable(flow, 'Send Consent Reaction', 'Materials Wait'));
  assert.ok(reachable(flow, 'Materials Wait', 'Send Materials Intro'));
  assert.ok(reachable(flow, 'Aggregate Sent Documents', 'Pix Wait'));
  assert.ok(reachable(flow, 'Pix Wait', 'Create Pending Sale'));
});

test('nine document items converge before creating one sale and one Pix message', async () => {
  const flow = await loadJson(workflowUrl);
  const aggregate = flow.nodes.find((node) => node.name === 'Aggregate Sent Documents');
  assert.ok(aggregate, 'O fluxo precisa agregar os nove resultados antes de continuar');
  assert.ok(reachable(flow, 'Send Document', 'Aggregate Sent Documents'));
  assert.ok(reachable(flow, 'Send Materials Intro', 'Send Materials'));
  assert.ok(reachable(flow, 'Aggregate Sent Documents', 'Create Pending Sale'));
  assert.equal(
    flow.connections['Send Document'].main.flat().some((edge) => edge.node === 'Create Pending Sale'),
    false,
  );
});

test('offer text reaches the details message without requiring an image file', async () => {
  const flow = await loadJson(workflowUrl);

  assert.ok(reachable(flow, 'Send Offer', 'Send Offer Details', new Set(['Read Offer Image', 'Send Offer Image'])));
});
