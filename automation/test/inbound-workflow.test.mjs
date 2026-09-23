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
    'Send Materials Intro', 'Send Consent Reaction', 'Find Pending Mercado Pago Pix',
    'Send Pending Mercado Pago Pix Code', 'Send Mercado Pago Pix Code', 'Respond Webhook',
    'Send Pix Bonus Value', 'Send Pix Bonus Finalize',
  ]) assert.ok(names.has(required), `Nó ausente: ${required}`);

  assert.ok(reachable(flow, 'Insert Event Once', 'Send Offer'));
  assert.equal(reachable(flow, 'Webhook Evolution', 'Send Offer', new Set(['Insert Event Once'])), false);
  assert.match(webhook.webhookId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});

test('every Evolution HTTP request uses the internal service and n8n credential', async () => {
  const flow = await loadJson(workflowUrl);
  const requests = flow.nodes.filter((node) => node.type === 'n8n-nodes-base.httpRequest');
  assert.ok(requests.length >= 5);
  for (const node of requests.filter((item) => String(item.parameters.url).includes('evolution-api'))) {
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

test('normalizer recognizes Meta Cloud API button replies', async () => {
  const flow = await loadJson(workflowUrl);
  const normalizer = node(flow, 'Normalize Event');
  const [item] = await executeCode(normalizer, { body: {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: {
      contacts: [{ profile: { name: 'Cliente Meta' }, wa_id: '5511999999999' }],
      messages: [{
        id: 'wamid.META-COPY-PIX-001',
        from: '5511999999999',
        timestamp: '1760000000',
        type: 'interactive',
        interactive: { button_reply: { id: 'copy_pix', title: '📋 Copiar Pix' } },
      }],
    } }] }],
  } });

  assert.equal(item.json.externalId, 'wamid.META-COPY-PIX-001');
  assert.equal(item.json.whatsappId, '5511999999999@s.whatsapp.net');
  assert.equal(item.json.phone, '5511999999999');
  assert.equal(item.json.intent, 'copy_pix');
  assert.equal(item.json.ignored, false);
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

test('payment reminder opt-out keyword cancels only payment reminders', async () => {
  const flow = await loadJson(workflowUrl);
  const normalizer = node(flow, 'Normalize Event');
  const routeState = node(flow, 'Route State');
  const cancel = node(flow, 'Cancel Payment Reminders');
  const confirmation = node(flow, 'Payment Reminders Off Confirmation');

  const fixture = {
    event: 'messages.upsert',
    instance: 'kit-matematica',
    data: {
      key: { id: 'REMINDER-OFF-2026', remoteJid: '5585997630433@s.whatsapp.net', fromMe: false },
      pushName: 'Cliente',
      messageType: 'conversation',
      message: { conversation: '2026' },
      messageTimestamp: 1789747200,
    },
  };

  const [normalized] = await executeCode(normalizer, { body: fixture });
  assert.equal(normalized.json.intent, 'payment_reminders_off');

  const [routed] = await executeRouteState(routeState, {
    ...normalized.json,
    inserted: true,
    state: 'awaiting_payment',
  });
  assert.equal(routed.json.route, 'payment_reminders_off');

  assert.ok(reachable(flow, 'Conversation Branch', 'Cancel Payment Reminders'));
  assert.ok(reachable(flow, 'Cancel Payment Reminders', 'Payment Reminders Off Confirmation'));
  assert.match(cancel.parameters.query, /UPDATE followups SET status = 'cancelled'/);
  assert.ok(cancel.parameters.query.includes("status IN ('pending', 'processing')"));
  assert.doesNotMatch(cancel.parameters.query, /state = 'stopped'/);
  assert.match(confirmation.parameters.body, /Os avisos de pagamento foram desativados para essa conversa!/);
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

  fixture.data.key.id = 'SMOKE-TEXT-002';
  fixture.data.message.conversation = 'quero o kit';
  const [oldTrigger] = await executeCode(normalizer, { body: fixture });
  assert.equal(oldTrigger.json.intent, 'other');

  fixture.data.key.id = 'SMOKE-TEXT-003';
  fixture.data.message.conversation = 'Olá! Gostaria de adquirir o kit de Matemática.';
  const [purchase] = await executeCode(normalizer, { body: fixture });
  assert.equal(purchase.json.intent, 'purchase');

  fixture.data.key.id = 'SMOKE-TEXT-004';
  fixture.data.message.conversation = 'Olá! Posso ter mais informações sobre isso?';
  const [info] = await executeCode(normalizer, { body: fixture });
  assert.equal(info.json.intent, 'purchase');

  fixture.data.key.id = 'SMOKE-TEXT-005';
  fixture.data.message.conversation = 'Olá, posso ter mais informações sobre isso';
  const [infoWithoutPunctuation] = await executeCode(normalizer, { body: fixture });
  assert.equal(infoWithoutPunctuation.json.intent, 'purchase');
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


test('receipt images notify the configured review number before acknowledging the customer', async () => {
  const flow = await loadJson(workflowUrl);
  const routeState = node(flow, 'Route State');
  const saveReceipt = node(flow, 'Save Receipt');
  const notify = node(flow, 'Notify Payment Review');

  const [receiptRoute] = await executeRouteState(routeState, {
    inserted: true,
    state: 'awaiting_payment',
    intent: 'receipt',
  });
  assert.equal(receiptRoute.json.route, 'receipt');
  assert.match(saveReceipt.parameters.query, /receipt_media_id/);
  assert.ok(reachable(flow, 'Save Receipt', 'Notify Payment Review'));
  assert.ok(reachable(flow, 'Notify Payment Review', 'Receipt Acknowledgement'));
  assert.match(notify.parameters.body, /paymentNotifyPhone/);
  assert.match(notify.parameters.body, /Comprovante recebido/);
  assert.match(notify.parameters.body, /confirmar no dashboard/);
  assert.equal(notify.onError, 'continueRegularOutput');
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
test('video timing uses humanized delays before materials, PDFs, and payment', async () => {
  const flow = await loadJson(workflowUrl);
  const offerWait = flow.nodes.find((node) => node.name === 'Offer Wait');
  const materialsWait = flow.nodes.find((node) => node.name === 'Materials Wait');
  const pixWait = flow.nodes.find((node) => node.name === 'Pix Wait');
  const insert = flow.nodes.find((node) => node.name === 'Insert Event Once');
  const createSale = flow.nodes.find((node) => node.name === 'Create Pending Sale');

  assert.equal(offerWait?.parameters.amount, 90);
  assert.equal(offerWait?.parameters.unit, 'seconds');
  assert.equal(materialsWait?.parameters.amount, 4);
  assert.equal(materialsWait?.parameters.unit, 'seconds');
  assert.equal(pixWait?.parameters.amount, 7);
  assert.equal(pixWait?.parameters.unit, 'seconds');
  assert.ok(reachable(flow, 'Aggregate Sent Documents', 'Pix Wait'));
  assert.ok(reachable(flow, 'Pix Wait', 'Create Pending Sale'));
  assert.equal(reachable(flow, 'Aggregate Sent Documents', 'Create Pending Sale', new Set(['Pix Wait'])), false);
  assert.match(insert.parameters.query, /'15,30,90,210,390,690,810'/);
  assert.match(createSale.parameters.options.queryReplacement, /'15,30,90,210,390,690,810'/);
  assert.match(createSale.parameters.query, /ON CONFLICT \(sale_id, sequence_number\) DO NOTHING/);
  assert.doesNotMatch(createSale.parameters.query, /ON CONFLICT \(contact_id, sequence_number\) DO NOTHING/);
  assert.ok(reachable(flow, 'Send Consent Reaction', 'Materials Wait'));
  assert.ok(reachable(flow, 'Materials Wait', 'Send Materials Intro'));
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
  assert.ok(reachable(flow, 'Aggregate Sent Documents', 'Pix Wait'));
  assert.equal(
    flow.connections['Send Document'].main.flat().some((edge) => edge.node === 'Create Pending Sale'),
    false,
  );
});

test('document PDFs are prepared as base64 before sending to Evolution', async () => {
  const flow = await loadJson(workflowUrl);
  const sendMaterials = node(flow, 'Send Materials');
  const sendDocument = node(flow, 'Send Document');

  assert.match(sendMaterials.parameters.jsCode, /readFileSync\(filePath\)/);
  assert.match(sendMaterials.parameters.jsCode, /toString\('base64'\)/);
  assert.match(sendMaterials.parameters.jsCode, /documentBase64/);
  assert.ok(reachable(flow, 'Send Materials', 'Send Document'));
  assert.match(sendDocument.parameters.body, /documentBase64/);
  assert.match(sendDocument.parameters.body, /delay:\s*2500/);
  assert.doesNotMatch(sendDocument.parameters.body, /\$binary\.data\.data/);
});

test('offer sequence sends the image with the complete benefits caption in one WhatsApp message', async () => {
  const flow = await loadJson(workflowUrl);
  const prepareImage = node(flow, 'Prepare Offer Image');
  const sendImage = node(flow, 'Send Offer Image');

  assert.match(prepareImage.parameters.jsCode, /readFileSync\(fullPath\)/);
  assert.match(prepareImage.parameters.jsCode, /toString\('base64'\)/);
  assert.match(prepareImage.parameters.jsCode, /offerImageBase64/);
  assert.ok(reachable(flow, 'Offer Wait', 'Prepare Offer Image'));
  assert.ok(reachable(flow, 'Prepare Offer Image', 'Send Offer Image'));
  assert.ok(reachable(flow, 'Send Offer Image', 'Send Offer Commitment'));
  assert.equal(reachable(flow, 'Send Offer Image', 'Send Offer Price'), false);
  assert.equal(sendImage.onError, 'continueRegularOutput');
  assert.equal(reachable(flow, 'Send Offer Image', 'Send Offer Details'), false);
  assert.equal(reachable(flow, 'Send Offer Image', 'Send Offer Benefits'), false);
  assert.match(sendImage.parameters.body, /offerImageBase64/);
  assert.doesNotMatch(sendImage.parameters.body, /\$binary\.data\.data/);
  assert.match(sendImage.parameters.body, /Kit de Matemática/);
  assert.match(sendImage.parameters.body, /O que você vai receber/);
  assert.match(prepareImage.parameters.jsCode, /ofertanova\.png/);
  assert.match(sendImage.parameters.body, /image\/png/);
  assert.match(sendImage.parameters.body, /900 atividades/);
  assert.match(sendImage.parameters.body, /\+900 Atividades/);
  assert.match(sendImage.parameters.body, /Material pronto para imprimir/);
  assert.match(sendImage.parameters.body, /outros bônus exclusivos/i);
});



test('offer presentation messages use fine tuned human-paced send delays', async () => {
  const flow = await loadJson(workflowUrl);
  const expected = new Map([
    ['Send Offer', 2500],
    ['Send Offer Context', 5500],
    ['Send Offer Image', 4500],
    ['Send Offer Commitment', 7000],
    ['Send Offer Trust', 4000],
    ['Send Materials Intro', 2500],
    ['Send Materials Intro Details', 3500],
    ['Send Pix Values', 6000],
    ['Send Pix Access', 4000],
  ]);
  for (const [name, delay] of expected) {
    assert.match(node(flow, name).parameters.body, new RegExp(`delay:\\s*${delay}`), `${name} deve usar delay de ${delay}ms`);
  }
});
test('offer script waits ninety seconds before the first presentation message', async () => {
  const flow = await loadJson(workflowUrl);
  const offerWait = node(flow, 'Offer Wait');

  assert.equal(offerWait.parameters.amount, 90);
  assert.equal(offerWait.parameters.unit, 'seconds');
  assert.ok(reachable(flow, 'Mark Awaiting Consent', 'Offer Wait'));
  assert.ok(reachable(flow, 'Offer Wait', 'Send Offer'));
  assert.ok(reachable(flow, 'Send Offer', 'Send Offer Context'));
  assert.ok(reachable(flow, 'Send Offer Context', 'Prepare Offer Image'));
  assert.equal(reachable(flow, 'Send Offer Context', 'Send Offer Welcome'), false);
  assert.equal(reachable(flow, 'Mark Awaiting Consent', 'Send Offer', new Set(['Offer Wait'])), false);
});

test('pix payment sequence skips the redundant material summary text', async () => {
  const flow = await loadJson(workflowUrl);

  assert.equal(reachable(flow, 'Create Pending Sale', 'Send Pix'), false);
  assert.ok(reachable(flow, 'Create Pending Sale', 'Send Pix Values'));
  const pixWait = node(flow, 'Pix Wait');
  assert.equal(pixWait.parameters.amount, 7);
  assert.equal(reachable(flow, 'Create Pending Sale', 'Prepare Mercado Pago Amounts'), false);
  assert.ok(reachable(flow, 'Create Pending Sale', 'Create Mercado Pago Pix'));
  assert.ok(reachable(flow, 'Create Mercado Pago Pix', 'Save Mercado Pago Pix'));
  assert.ok(reachable(flow, 'Send Pix Values', 'Send Pix Access'));
  assert.ok(reachable(flow, 'Send Pix Access', 'Mercado Pago Pix Branch'));
  assert.ok(reachable(flow, 'Mercado Pago Pix Branch', 'Send Evolution GO Dynamic Pix Card'));
  assert.ok(reachable(flow, 'Send Evolution GO Dynamic Pix Card', 'Send Pix Receipt'));
  assert.ok(reachable(flow, 'Send Pix Receipt', 'Send Pix Bonus Value'));
  assert.ok(reachable(flow, 'Send Pix Bonus Value', 'Send Pix Bonus Finalize'));
  assert.equal(reachable(flow, 'Send Evolution GO Dynamic Pix Card', 'Send Payment Verify Instruction'), false);
  assert.equal(reachable(flow, 'Mercado Pago Pix Branch', 'Send Mercado Pago QR Image'), false);
});
test('sales script sends long copy as separate conversational WhatsApp messages', async () => {
  const flow = await loadJson(workflowUrl);

  const expectedOrder = [
    ['Send Offer', 'Send Offer Context'],
    ['Send Offer Context', 'Prepare Offer Image'],
    ['Mark Awaiting Consent', 'Offer Wait'],
    ['Offer Wait', 'Send Offer'],
    ['Send Offer Image', 'Send Offer Commitment'],
    ['Send Offer Commitment', 'Send Offer Trust'],
    ['Send Offer Trust', 'Respond Webhook'],
    ['Send Materials Intro', 'Send Materials Intro Details'],
    ['Send Materials Intro Details', 'Send Materials'],
    ['Aggregate Sent Documents', 'Pix Wait'],
    ['Pix Wait', 'Create Pending Sale'],
    ['Create Pending Sale', 'Create Mercado Pago Pix'],
    ['Create Mercado Pago Pix', 'Save Mercado Pago Pix'],
    ['Save Mercado Pago Pix', 'Send Pix Values'],
    ['Send Pix Values', 'Send Pix Access'],
    ['Send Pix Access', 'Mercado Pago Pix Branch'],
    ['Mercado Pago Pix Branch', 'Send Evolution GO Dynamic Pix Card'],
    ['Send Evolution GO Dynamic Pix Card', 'Send Pix Receipt'],
    ['Send Pix Receipt', 'Send Pix Bonus Value'],
    ['Send Pix Bonus Value', 'Send Pix Bonus Finalize'],
    ['Send Pix Bonus Finalize', 'Respond Webhook'],
  ];

  for (const [from, to] of expectedOrder) assert.ok(reachable(flow, from, to), `${from} deve chegar em ${to}`);

  assert.match(node(flow, 'Send Offer').parameters.body, /Olá, Tudo bem/);
  assert.match(node(flow, 'Send Offer Context').parameters.body, /Separei um material lindo/);
  const names = new Set(flow.nodes.map((item) => item.name));
  assert.equal(names.has('Send Offer Welcome'), false);
  assert.equal(names.has('Send Offer Contact'), false);
  assert.equal(names.has('Send Offer Price'), false);
  assert.match(node(flow, 'Send Offer Commitment').parameters.body, /prévia do material/);
  assert.match(node(flow, 'Send Offer Commitment').parameters.body, /kit completo/);
  assert.match(node(flow, 'Send Offer Commitment').parameters.body, /R\$10,00/);
  assert.match(node(flow, 'Send Offer Trust').parameters.body, /Posso te enviar a prévia agora/);
  assert.match(node(flow, 'Send Materials Intro').parameters.body, /Vou te enviar/);
  assert.match(node(flow, 'Send Materials Intro Details').parameters.body, /Segue pdf/);
  assert.match(node(flow, 'Send Pix Values').parameters.body, /prévia já te ajudou/);
  assert.match(node(flow, 'Send Pix Values').parameters.body, /apostilas \+ bônus completos/);
  assert.doesNotMatch(node(flow, 'Send Pix Values').parameters.body, /\*\*/);
  assert.doesNotMatch(node(flow, 'Send Pix Values').parameters.body, /PIX:/);
  assert.match(node(flow, 'Send Pix Access').parameters.body, /Acesso imediato/);
  const dynamicCard = node(flow, 'Send Evolution GO Dynamic Pix Card');
  assert.match(dynamicCard.parameters.body, /mercadoPagoQrCode/);
  assert.match(dynamicCard.parameters.body, /keyType:\s*'random'/);
  assert.match(dynamicCard.parameters.body, /delay:\s*3000/);
  assert.equal(reachable(flow, 'Send Evolution GO Dynamic Pix Card', 'Send Mercado Pago Pix Code'), false);
  assert.equal(reachable(flow, 'Send Evolution GO Dynamic Pix Card', 'Send Payment Verify Instruction'), false);
  assert.equal(reachable(flow, 'Mercado Pago Pix Branch', 'Send Mercado Pago QR Image'), false);
  assert.match(node(flow, 'Send Pix Receipt').parameters.body, /BÔNUS EXCLUSIVO LIBERADO/);
  assert.match(node(flow, 'Send Pix Receipt').parameters.body, /delay:\s*15000/);
  assert.doesNotMatch(node(flow, 'Send Pix Receipt').parameters.body, /Finalize o pagamento/);
  assert.match(node(flow, 'Send Pix Bonus Value').parameters.body, /R\$19,90/);
  assert.match(node(flow, 'Send Pix Bonus Value').parameters.body, /delay:\s*4000/);
  assert.match(node(flow, 'Send Pix Bonus Finalize').parameters.body, /Finalize o pagamento/);
  assert.match(node(flow, 'Send Pix Bonus Finalize').parameters.body, /delay:\s*3500/);
  assert.match(node(flow, 'Send Mercado Pago Pix Code').parameters.body, /mercadoPagoQrCode/);
  assert.match(node(flow, 'Send Mercado Pago Pix Code').parameters.body, /Pix copia e cola dinâmico/);
});

test('copy pix replies send the saved dynamic Mercado Pago code', async () => {
  const flow = await loadJson(workflowUrl);
  const normalizer = node(flow, 'Normalize Event');
  const routeState = node(flow, 'Route State');

  const [normalized] = await executeCode(normalizer, {
    event: 'messages.upsert',
    instance: 'kit-matematica',
    data: {
      key: { id: 'COPY-PIX-001', remoteJid: '5511999999999@s.whatsapp.net', fromMe: false },
      messageType: 'conversation',
      message: { conversation: 'copiar pix' },
      messageTimestamp: 1760000000,
    },
  });
  assert.equal(normalized.json.intent, 'copy_pix');

  const [copyPix] = await executeRouteState(routeState, {
    inserted: true,
    state: 'awaiting_payment',
    intent: 'copy_pix',
    messageType: 'text',
    text: 'copiar pix',
  });

  assert.equal(copyPix.json.route, 'copy_pix');
  assert.ok(reachable(flow, 'Conversation Branch', 'Find Pending Mercado Pago Pix'));
  assert.ok(reachable(flow, 'Find Pending Mercado Pago Pix', 'Send Pending Mercado Pago Pix Code'));
  assert.match(node(flow, 'Find Pending Mercado Pago Pix').parameters.query, /mercado_pago_qr_code/);
  assert.match(node(flow, 'Send Pending Mercado Pago Pix Code').parameters.body, /mercadoPagoQrCode/);
  assert.match(node(flow, 'Send Pending Mercado Pago Pix Code').parameters.body, /único para o seu pedido/);
});

test('paid check replies trigger immediate Mercado Pago verification', async () => {
  const flow = await loadJson(workflowUrl);
  const routeState = node(flow, 'Route State');

  const [paidCheck] = await executeRouteState(routeState, {
    inserted: true,
    state: 'awaiting_payment',
    intent: 'paid_check',
  });

  assert.equal(paidCheck.json.route, 'verify_payment');
  assert.ok(reachable(flow, 'Conversation Branch', 'Send Payment Check Started'));
  assert.ok(reachable(flow, 'Send Payment Check Started', 'Find Payment For Verification'));
  assert.ok(reachable(flow, 'Find Payment For Verification', 'Search Payment On Demand'));
  assert.ok(reachable(flow, 'Search Payment On Demand', 'Record On Demand Payment'));
  assert.ok(reachable(flow, 'Record On Demand Payment', 'Payment Verification Branch'));
  assert.ok(reachable(flow, 'Payment Verification Branch', 'Send Payment Verified'));
  assert.ok(reachable(flow, 'Payment Verification Branch', 'Send Payment Not Found'));
});


test('full payer name replies trigger assisted Mercado Pago verification', async () => {
  const flow = await loadJson(workflowUrl);
  const routeState = node(flow, 'Route State');

  const [nameReply] = await executeRouteState(routeState, {
    inserted: true,
    state: 'awaiting_payment',
    intent: 'other',
    messageType: 'text',
    text: 'João da Silva',
  });

  assert.equal(nameReply.json.route, 'payment_name');
  assert.ok(reachable(flow, 'Conversation Branch', 'Send Payment Name Check Started'));
  assert.ok(reachable(flow, 'Send Payment Name Check Started', 'Find Sale For Name Verification'));
  assert.ok(reachable(flow, 'Find Sale For Name Verification', 'Search Recent Mercado Pago Payments'));
  assert.ok(reachable(flow, 'Search Recent Mercado Pago Payments', 'Match Mercado Pago Payment By Name'));
  assert.ok(reachable(flow, 'Match Mercado Pago Payment By Name', 'Record Name Payment Check'));
  assert.ok(reachable(flow, 'Record Name Payment Check', 'Payment Name Match Branch'));
  assert.ok(reachable(flow, 'Payment Name Match Branch', 'Notify Payment Name Match Admin'));
  assert.ok(reachable(flow, 'Payment Name Match Branch', 'Send Payment Name Not Found'));
});

test('name based payment verification is assisted and does not auto-release access', async () => {
  const flow = await loadJson(workflowUrl);
  const findSale = node(flow, 'Find Sale For Name Verification');
  const search = node(flow, 'Search Recent Mercado Pago Payments');
  const match = node(flow, 'Match Mercado Pago Payment By Name');
  const record = node(flow, 'Record Name Payment Check');
  const notify = node(flow, 'Notify Payment Name Match Admin');
  const customerFound = node(flow, 'Send Payment Name Match Found');

  assert.match(findSale.parameters.query, /typedPayerName/);
  assert.match(search.parameters.url, /payments\/search/);
  assert.match(search.parameters.url, /status=approved/);
  assert.match(match.parameters.jsCode, /typedTokens/);
  assert.match(match.parameters.jsCode, /minimumAmount/);
  assert.match(record.parameters.query, /payment_possible_name_match/);
  assert.match(match.parameters.jsCode, /single_recent_pix/);
  assert.match(match.parameters.jsCode, /candidatePaymentCount/);
  assert.match(record.parameters.query, /payment_name_not_found/);
  assert.doesNotMatch(record.parameters.query, /status = 'paid'/);
  assert.match(notify.parameters.body, /Possível pagamento encontrado no Mercado Pago/);
  assert.match(notify.parameters.body, /confirm[e]? a venda/i);
  assert.match(customerFound.parameters.body, /possível pagamento/);
});



test('temporary PDF media upload failures do not block the Pix sequence', async () => {
  const flow = await loadJson(workflowUrl);
  const sendDocument = node(flow, 'Send Document');
  const aggregate = node(flow, 'Aggregate Sent Documents');

  assert.equal(sendDocument.onError, 'continueRegularOutput');
  assert.equal(sendDocument.retryOnFail, true);
  assert.ok(Number(sendDocument.maxTries) >= 3);
  assert.doesNotMatch(aggregate.parameters.jsCode, /throw new Error/);
  assert.ok(reachable(flow, 'Send Document', 'Aggregate Sent Documents'));
  assert.ok(reachable(flow, 'Aggregate Sent Documents', 'Create Pending Sale'));
  assert.ok(reachable(flow, 'Create Pending Sale', 'Send Pix Values'));
});



