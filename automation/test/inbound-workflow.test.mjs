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

function node(flow, name) {
  const found = flow.nodes.find((item) => item.name === name);
  assert.ok(found, `Nó ausente: ${name}`);
  return found;
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

test('early replies during the offer presentation do not release materials', async () => {
  const flow = await loadJson(workflowUrl);
  const routeState = node(flow, 'Route State');

  const [earlyReply] = await executeRouteState(routeState, {
    inserted: true,
    state: 'offered',
    intent: 'other',
  });
  assert.equal(earlyReply.json.route, 'duplicate');

  const markInitialOffer = node(flow, 'Mark Awaiting Consent');
  assert.match(markInitialOffer.parameters.query, /state = 'offered'/);

  const markReady = node(flow, 'Mark Awaiting Consent After Offer');
  assert.match(markReady.parameters.query, /state = 'awaiting_consent'/);
  assert.ok(reachable(flow, 'Send Offer Trust', 'Mark Awaiting Consent After Offer'));
  assert.ok(reachable(flow, 'Mark Awaiting Consent After Offer', 'Respond Webhook'));
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


test('materials files are validated before the contact is marked as sending materials', async () => {
  const flow = await loadJson(workflowUrl);
  const validate = node(flow, 'Validate Materials Files');

  assert.match(validate.parameters.jsCode, /missingFiles/);
  assert.match(validate.parameters.jsCode, /fs\.existsSync/);
  assert.ok(reachable(flow, 'Conversation Branch', 'Validate Materials Files'));
  assert.ok(reachable(flow, 'Validate Materials Files', 'Mark Sending Materials'));
  assert.equal(reachable(flow, 'Conversation Branch', 'Mark Sending Materials', new Set(['Validate Materials Files'])), false);
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

test('offer sequence sends the promotional image before offer details', async () => {
  const flow = await loadJson(workflowUrl);

  assert.ok(reachable(flow, 'Offer Wait', 'Read Offer Image'));
  assert.ok(reachable(flow, 'Read Offer Image', 'Send Offer Image'));
  assert.ok(reachable(flow, 'Send Offer Image', 'Send Offer Details'));
  assert.equal(reachable(flow, 'Offer Wait', 'Send Offer Details', new Set(['Read Offer Image', 'Send Offer Image'])), false);
});

test('offer image reads the configured promotional image file', async () => {
  const flow = await loadJson(workflowUrl);
  const readImage = node(flow, 'Read Offer Image');

  assert.equal(readImage.parameters.fileSelector, '/files/oferta.jpg');
});

test('sales script sends long copy as separate conversational WhatsApp messages', async () => {
  const flow = await loadJson(workflowUrl);

  const expectedOrder = [
    ['Send Offer', 'Send Offer Context'],
    ['Send Offer Context', 'Send Offer Welcome'],
    ['Send Offer Welcome', 'Send Offer Contact'],
    ['Send Offer Contact', 'Offer Wait'],
    ['Send Offer Details', 'Send Offer Benefits'],
    ['Send Offer Benefits', 'Send Offer Price'],
    ['Send Offer Price', 'Send Offer Commitment'],
    ['Send Offer Commitment', 'Send Offer Trust'],
    ['Send Offer Trust', 'Respond Webhook'],
    ['Send Materials Intro', 'Send Materials Intro Details'],
    ['Send Materials Intro Details', 'Send Materials'],
    ['Send Pix', 'Send Pix Values'],
    ['Send Pix Values', 'Send Pix Access'],
    ['Send Pix Access', 'Send Pix Key'],
    ['Send Pix Key', 'Send Pix Receipt'],
    ['Send Pix Receipt', 'Respond Webhook'],
  ];

  for (const [from, to] of expectedOrder) assert.ok(reachable(flow, from, to), `${from} deve chegar em ${to}`);

  assert.match(node(flow, 'Send Offer').parameters.body, /Olá, Tudo bem/);
  assert.match(node(flow, 'Send Offer Context').parameters.body, /Separei um material lindo/);
  assert.match(node(flow, 'Send Offer Welcome').parameters.body, /Fico feliz/);
  assert.match(node(flow, 'Send Offer Contact').parameters.body, /Me adiciona nos contatos/);
  assert.match(node(flow, 'Send Offer Details').parameters.body, /O que você vai receber/);
  assert.match(node(flow, 'Send Offer Benefits').parameters.body, /887 Atividades/);
  assert.match(node(flow, 'Send Offer Price').parameters.body, /pagamento único/);
  assert.match(node(flow, 'Send Offer Commitment').parameters.body, /confiança e compromisso/);
  assert.match(node(flow, 'Send Offer Trust').parameters.body, /posso confiar/);
  assert.match(node(flow, 'Send Materials Intro').parameters.body, /Vou te enviar/);
  assert.match(node(flow, 'Send Materials Intro Details').parameters.body, /Segue pdf/);
  assert.match(node(flow, 'Send Pix').parameters.body, /Todas as outras atividades/);
  assert.match(node(flow, 'Send Pix Values').parameters.body, /R\$10,00/);
  assert.match(node(flow, 'Send Pix Access').parameters.body, /Acesso imediato/);
  assert.match(node(flow, 'Send Pix Key').parameters.body, /Pagamento via PIX/);
  assert.match(node(flow, 'Send Pix Receipt').parameters.body, /envie o comprovante/);
});

