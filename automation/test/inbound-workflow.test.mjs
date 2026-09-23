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
    'Send Pix Bonus Value',
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
  const [buyIntent] = await executeCode(normalizer, { body: fixture });
  assert.equal(buyIntent.json.intent, 'affirmative');

  fixture.data.key.id = 'SMOKE-TEXT-003';
  fixture.data.message.conversation = 'Olá! Gostaria de adquirir o kit de Matemática.';
  const [purchase] = await executeCode(normalizer, { body: fixture });
  assert.equal(purchase.json.intent, 'purchase');

  fixture.data.key.id = 'SMOKE-TEXT-004';
  fixture.data.message.conversation = 'Olá! Posso ter mais informações sobre isso?';
  const [info] = await executeCode(normalizer, { body: fixture });
  assert.equal(info.json.intent, 'purchase');
});

test('purchase flow asks the year and waits before showing samples', async () => {
  const flow = await loadJson(workflowUrl);
  const routeState = node(flow, 'Route State');

  const [purchaseRoute] = await executeRouteState(routeState, { inserted: true, state: 'new', intent: 'purchase' });
  assert.equal(purchaseRoute.json.route, 'offer');

  const [stoppedRestart] = await executeRouteState(routeState, { inserted: true, state: 'stopped', intent: 'purchase' });
  assert.equal(stoppedRestart.json.route, 'offer');

  const markInitialOffer = node(flow, 'Mark Awaiting Consent');
  assert.match(markInitialOffer.parameters.query, /state = 'offered'/);
  assert.ok(reachable(flow, 'Mark Awaiting Consent', 'Offer Wait'));
  assert.ok(reachable(flow, 'Offer Wait', 'Send Offer'));
  assert.ok(reachable(flow, 'Send Offer', 'Send Offer Context'));
  assert.ok(reachable(flow, 'Send Offer Context', 'Send Offer Trust'));
  assert.ok(reachable(flow, 'Send Offer Trust', 'Mark Awaiting Consent After Offer'));
  assert.ok(reachable(flow, 'Mark Awaiting Consent After Offer', 'Respond Webhook'));
  assert.equal(reachable(flow, 'Send Offer Context', 'Prepare Offer Image'), false);

  assert.match(node(flow, 'Send Offer').parameters.body, /Oii, prof 💙 Claro!/);
  assert.match(node(flow, 'Send Offer Context').parameters.body, /mais de 900 atividades/);
  assert.match(node(flow, 'Send Offer Trust').parameters.body, /Você trabalha com qual ano/);
  assert.match(node(flow, 'Mark Awaiting Consent After Offer').parameters.query, /state = 'awaiting_consent'/);
});

test('school year answers are interpreted only while awaiting the year', async () => {
  const flow = await loadJson(workflowUrl);
  const routeState = node(flow, 'Route State');

  const [thirdYear] = await executeRouteState(routeState, {
    inserted: true,
    state: 'awaiting_consent',
    intent: 'other',
    messageType: 'text',
    text: 'dou aula para o 3 ano',
  });
  assert.equal(thirdYear.json.route, 'samples');
  assert.equal(thirdYear.json.selectedYear, 3);
  assert.equal(thirdYear.json.selectedYearLabel, '3º ano');

  const [wordYear] = await executeRouteState(routeState, {
    inserted: true,
    state: 'awaiting_consent',
    intent: 'other',
    messageType: 'text',
    text: 'trabalho com primeiro',
  });
  assert.equal(wordYear.json.route, 'samples');
  assert.equal(wordYear.json.selectedYear, 1);

  const [outOfContextDigit] = await executeRouteState(routeState, {
    inserted: true,
    state: 'new',
    intent: 'other',
    messageType: 'text',
    text: '1',
  });
  assert.equal(outOfContextDigit.json.route, 'duplicate');

  const [unknownYear] = await executeRouteState(routeState, {
    inserted: true,
    state: 'awaiting_consent',
    intent: 'other',
    messageType: 'text',
    text: 'qualquer uma',
  });
  assert.equal(unknownYear.json.route, 'year_retry');
  assert.ok(reachable(flow, 'Conversation Branch', 'Send Year Retry'));
  assert.match(node(flow, 'Send Year Retry').parameters.body, /Só me fala qual turma/);
});

test('selected year sends exactly three sample images from materials activities folders', async () => {
  const flow = await loadJson(workflowUrl);
  const prepare = node(flow, 'Prepare Year Samples');
  const sendImage = node(flow, 'Send Year Sample Image');

  assert.ok(reachable(flow, 'Conversation Branch', 'Send Year Samples Intro'));
  assert.ok(reachable(flow, 'Send Year Samples Intro', 'Prepare Year Samples'));
  assert.ok(reachable(flow, 'Prepare Year Samples', 'Send Year Sample Image'));
  assert.ok(reachable(flow, 'Send Year Sample Image', 'Aggregate Year Samples'));
  assert.ok(reachable(flow, 'Aggregate Year Samples', 'Send Sample Summary'));
  assert.ok(reachable(flow, 'Send Sample Summary', 'Send Kit Includes'));
  assert.ok(reachable(flow, 'Send Kit Includes', 'Send Kit Confirm Question'));
  assert.ok(reachable(flow, 'Send Kit Confirm Question', 'Mark Awaiting Purchase Confirm'));
  assert.ok(reachable(flow, 'Mark Awaiting Purchase Confirm', 'Respond Webhook'));

  assert.match(prepare.parameters.jsCode, /atividades/);
  assert.match(prepare.parameters.jsCode, /Primeiro Ano/);
  assert.match(prepare.parameters.jsCode, /Nono Ano/);
  assert.match(prepare.parameters.jsCode, /slice\(0, 3\)/);
  assert.match(sendImage.parameters.body, /mediatype: 'image'/);
  assert.match(sendImage.parameters.body, /sampleImageBase64/);
  assert.match(node(flow, 'Send Year Samples Intro').parameters.body, /Perfeito 💙 Vou te mostrar algumas atividades/);
  assert.match(node(flow, 'Send Kit Confirm Question').parameters.body, /Quer pegar o kit completo por R\$10\? 💙/);
  assert.equal(reachable(flow, 'Conversation Branch', 'Validate Materials Files'), false);
  assert.equal(reachable(flow, 'Conversation Branch', 'Send Document'), false);
});

test('purchase confirmation calls the existing Mercado Pago Pix path and leaves post Pix flow intact', async () => {
  const flow = await loadJson(workflowUrl);
  const routeState = node(flow, 'Route State');

  const [confirm] = await executeRouteState(routeState, {
    inserted: true,
    state: 'offered',
    intent: 'affirmative',
    messageType: 'text',
    text: 'quero o kit',
  });
  assert.equal(confirm.json.route, 'confirm_purchase');

  assert.ok(reachable(flow, 'Conversation Branch', 'Send Pre Pix OK'));
  assert.ok(reachable(flow, 'Send Pre Pix OK', 'Send Pre Pix Explanation'));
  assert.ok(reachable(flow, 'Send Pre Pix Explanation', 'Send Pre Pix Receiver'));
  assert.ok(reachable(flow, 'Send Pre Pix Receiver', 'Create Pending Sale'));
  assert.ok(reachable(flow, 'Create Pending Sale', 'Create Mercado Pago Pix'));
  assert.ok(reachable(flow, 'Create Mercado Pago Pix', 'Save Mercado Pago Pix'));
  assert.ok(reachable(flow, 'Save Mercado Pago Pix', 'Mercado Pago Pix Branch'));
  assert.equal(reachable(flow, 'Save Mercado Pago Pix', 'Send Pix Values'), false);
  assert.equal(reachable(flow, 'Save Mercado Pago Pix', 'Send Pix Access'), false);
  assert.doesNotMatch(node(flow, 'Create Pending Sale').parameters.query, /INSERT INTO followups/i);
  assert.match(node(flow, 'Create Pending Sale').parameters.query, /next_followup_at = NULL/i);
  assert.match(node(flow, 'Send Pre Pix OK').parameters.body, /Perfeito 😊💙/);
  assert.match(node(flow, 'Send Pre Pix OK').parameters.body, /delay: 1500/);
  assert.match(node(flow, 'Send Pre Pix Explanation').parameters.body, /O pagamento é via Pix e, assim que for confirmado, o material completo é liberado automaticamente\./);
  assert.match(node(flow, 'Send Pre Pix Explanation').parameters.body, /delay: 1500/);
  assert.match(node(flow, 'Send Pre Pix Receiver').parameters.body, /O Pix aparecerá em nome de Vicenzo Hoffmann, responsável pelo Universo Pedagógico 💙/);
  assert.match(node(flow, 'Send Pre Pix Receiver').parameters.body, /delay: 1500/);

  assert.ok(reachable(flow, 'Mercado Pago Pix Branch', 'Send Evolution GO Dynamic Pix Card'));
  assert.ok(reachable(flow, 'Send Evolution GO Dynamic Pix Card', 'Send Pix Receipt'));
  assert.ok(reachable(flow, 'Send Pix Receipt', 'Send Pix Bonus Value'));
  assert.equal(reachable(flow, 'Send Pix Bonus Value', 'Send Pix Bonus Finalize'), false);
  assert.ok(reachable(flow, 'Send Pix Bonus Value', 'Respond Webhook'));

  assert.match(node(flow, 'Send Evolution GO Dynamic Pix Card').parameters.body, /Save Mercado Pago Pix/);
  assert.match(node(flow, 'Send Evolution GO Dynamic Pix Card').parameters.body, /mercadoPagoQrCode/);
  assert.match(node(flow, 'Send Pix Receipt').parameters.body, /Assim que o pagamento for confirmado, eu já libero seu material completo por aqui 😊/);
  assert.match(node(flow, 'Send Pix Receipt').parameters.body, /delay: 2500/);
  assert.match(node(flow, 'Send Pix Bonus Value').parameters.body, /E junto com o kit você também recebe um bônus exclusivo sem nenhum custo a mais 💙/);
  assert.match(node(flow, 'Send Pix Bonus Value').parameters.body, /delay: 1500/);
  assert.doesNotMatch(JSON.stringify(flow), /Depois de pagar, é só me avisar por aqui que eu acompanho a confirmação/);
  const pixStageBodies = [
    node(flow, 'Send Pre Pix OK').parameters.body,
    node(flow, 'Send Pre Pix Explanation').parameters.body,
    node(flow, 'Send Pre Pix Receiver').parameters.body,
    node(flow, 'Send Pix Receipt').parameters.body,
    node(flow, 'Send Pix Bonus Value').parameters.body,
  ].join('\n');
  assert.doesNotMatch(pixStageBodies, /BÔNUS EXCLUSIVO LIBERADO APÓS O PAGAMENTO/);
  assert.doesNotMatch(pixStageBodies, /R\$19,90 totalmente GRÁTIS/);
  assert.doesNotMatch(pixStageBodies, /Finalize o pagamento e receba o material \+ seu bônus exclusivo/);
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
  const normalizer = node(flow, 'Normalize Event');
  const routeState = node(flow, 'Route State');

  for (const text of [
    'já paguei',
    'Paguei!',
    'fiz o pix',
    'pix feito',
    'pagamento feito',
    'efetuei o pagamento',
    'já fiz o pagamento',
    'pronto, paguei',
    'acabei de pagar',
    'fiz o pagamento',
    'já apareceu?',
    'consegue verificar?',
    'confere de novo',
    'agora foi',
    'paguei, consegue olhar?',
  ]) {
    const [normalized] = await executeCode(normalizer, {
      event: 'messages.upsert',
      instance: 'kit-matematica',
      data: {
        key: { id: `PAID-${text}`, remoteJid: '5511999999999@s.whatsapp.net', fromMe: false },
        messageType: 'conversation',
        message: { conversation: text },
        messageTimestamp: 1760000000,
      },
    });
    assert.equal(normalized.json.intent, 'paid_check', text);
  }

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
  assert.match(node(flow, 'Send Payment Check Started').parameters.body, /Vou conferir aqui pra você 😊/);
  assert.match(node(flow, 'Send Payment Not Found').parameters.body, /Ainda não apareceu como aprovado por aqui\. Às vezes o Pix leva alguns minutos para atualizar 😊 Assim que confirmar, eu libero automaticamente\./);
});

test('neutral replies after Pix wait silently without checking payment', async () => {
  const flow = await loadJson(workflowUrl);
  const normalizer = node(flow, 'Normalize Event');
  const routeState = node(flow, 'Route State');

  for (const text of ['ok', 'entendi', 'beleza', 'tá certo', 'certo', 'blz', 'obrigada', 'obrigado', 'show', 'tranquilo', '👍', '😊', 'feito', 'pronto']) {
    const [normalized] = await executeCode(normalizer, {
      event: 'messages.upsert',
      instance: 'kit-matematica',
      data: {
        key: { id: `NEUTRAL-${text}`, remoteJid: '5511999999999@s.whatsapp.net', fromMe: false },
        messageType: 'conversation',
        message: { conversation: text },
        messageTimestamp: 1760000000,
      },
    });
    assert.notEqual(normalized.json.intent, 'paid_check', text);

    const [routed] = await executeRouteState(routeState, {
      inserted: true,
      state: 'awaiting_payment',
      intent: normalized.json.intent,
      messageType: 'text',
      text,
    });
    assert.equal(routed.json.route, 'duplicate', text);
  }
});

test('plain text after Pix no longer triggers assisted Mercado Pago verification', async () => {
  const flow = await loadJson(workflowUrl);
  const routeState = node(flow, 'Route State');

  const [nameReply] = await executeRouteState(routeState, {
    inserted: true,
    state: 'awaiting_payment',
    intent: 'other',
    messageType: 'text',
    text: 'João da Silva',
  });

  assert.equal(nameReply.json.route, 'duplicate');
  assert.equal(reachable(flow, 'Conversation Branch', 'Send Payment Name Check Started'), true);
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



test('old PDF preview media upload failures are outside the active pre Pix flow', async () => {
  const flow = await loadJson(workflowUrl);
  const sendDocument = node(flow, 'Send Document');
  const aggregate = node(flow, 'Aggregate Sent Documents');

  assert.equal(sendDocument.onError, 'continueRegularOutput');
  assert.equal(sendDocument.retryOnFail, true);
  assert.ok(Number(sendDocument.maxTries) >= 3);
  assert.doesNotMatch(aggregate.parameters.jsCode, /throw new Error/);
  assert.ok(reachable(flow, 'Send Document', 'Aggregate Sent Documents'));
  assert.ok(reachable(flow, 'Aggregate Sent Documents', 'Create Pending Sale'));
  assert.equal(reachable(flow, 'Create Pending Sale', 'Send Pix Values'), false);
  assert.ok(reachable(flow, 'Create Pending Sale', 'Create Mercado Pago Pix'));
  assert.ok(reachable(flow, 'Save Mercado Pago Pix', 'Mercado Pago Pix Branch'));
});



