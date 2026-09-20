'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../src/app');

const testHash = 'scrypt$16384$8$1$Y29kZXgtbG9jYWwtc2FsdA==$954a79abc12d07c146c7cd7174b11fa7d0f95560ef9842e013cc4984e693844765329901023abe6ff6d9302a7d5adfc36d9b7c9eccbe61b4873e35a80fd80e84';

function csrfFrom(html) {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(match, 'A página precisa expor o token CSRF em um formulário');
  return match[1];
}

function makeApp() {
  const calls = { confirmPayment: [], markUnpaid: [], setAutomationState: [], saveMessageSettings: [] };
  const salesService = {
    async listSummary() {
      return {
        summary: { revenue: '19.80', paid: 2, pending: 1, contacts: 3 },
        daily: [{ day: '2026-09-18', sales: 2, revenue: '19.80' }],
        contacts: [{
          id: 3, display_name: 'Maria', phone: '5511999999999', state: 'awaiting_payment',
          sale_id: 7, status: 'pending', expected_amount: '9.90', created_at: new Date('2026-09-18T12:00:00Z'),
        }],
      };
    },
    async getContact(id) {
      if (Number(id) !== 3) return null;
      return {
        contact: { id: 3, display_name: 'Maria', phone: '5511999999999', state: 'awaiting_payment' },
        sales: [{ id: 7, status: 'pending', expected_amount: '9.90' }],
        messages: [],
        followups: [],
      };
    },
    async confirmPayment(input) { calls.confirmPayment.push(input); return { changed: true }; },
    async markUnpaid(input) { calls.markUnpaid.push(input); return { changed: true }; },
    async setAutomationState(input) { calls.setAutomationState.push(input); return { changed: true }; },
    async getMessageSettings() { return { steps: { offer_greeting: { label: 'Saudação', type: 'text', enabled: true, delayMs: 900, text: 'Olá, Tudo bem? 😊' } }, followups: {} }; },
    async saveMessageSettings(input) { calls.saveMessageSettings.push(input); return { changed: true }; },
  };
  return {
    app: createApp({
      salesService,
      authConfig: { username: 'admin', passwordHash: testHash, sessionSecret: 'test-session-secret' },
    }),
    calls,
  };
}

async function login(agent, password = 'troque-esta-senha') {
  const loginPage = await agent.get('/login').expect(200);
  return agent.post('/login').type('form').send({
    _csrf: csrfFrom(loginPage.text),
    username: 'admin',
    password,
  });
}

test('dashboard redirects anonymous users to login', async () => {
  const { app } = makeApp();
  await request(app).get('/').expect(302).expect('Location', '/login');
});

test('login rejects a wrong password and accepts the configured scrypt password', async () => {
  const { app } = makeApp();
  const wrongAgent = request.agent(app);
  await login(wrongAgent, 'errada').then((response) => assert.equal(response.status, 401));

  const agent = request.agent(app);
  await login(agent).then((response) => assert.equal(response.status, 303));
  const dashboard = await agent.get('/').expect(200);
  assert.match(dashboard.text, /R\$\s*19,80/);
  assert.match(dashboard.text, /Maria/);
});

test('payment confirmation requires CSRF and calls the domain service once', async () => {
  const { app, calls } = makeApp();
  const agent = request.agent(app);
  await login(agent).then((response) => assert.equal(response.status, 303));

  await agent.post('/sales/7/confirm').type('form').send({ amount: '9.90' }).expect(403);
  const contact = await agent.get('/contacts/3').expect(200);
  const token = csrfFrom(contact.text);
  await agent.post('/sales/7/confirm').type('form').send({
    _csrf: token,
    contactId: '3',
    amount: '9.90',
  }).expect(303).expect('Location', '/contacts/3');

  assert.deepEqual(calls.confirmPayment, [{ saleId: '7', amount: '9.90', actor: 'admin' }]);
});

test('unknown contacts return 404 after authentication', async () => {
  const { app } = makeApp();
  const agent = request.agent(app);
  await login(agent).then((response) => assert.equal(response.status, 303));
  await agent.get('/contacts/999').expect(404);
});


test('message manager renders current messages and saves edits', async () => {
  const { app, calls } = makeApp();
  const agent = request.agent(app);
  await login(agent).then((response) => assert.equal(response.status, 303));

  const page = await agent.get('/messages').expect(200);
  assert.match(page.text, /Gerenciar mensagens/);
  assert.match(page.text, /Olá, Tudo bem/);
  const token = csrfFrom(page.text);

  await agent.post('/messages').type('form').send({
    _csrf: token,
    step_offer_greeting_enabled: 'on',
    step_offer_greeting_delayMs: '500',
    step_offer_greeting_text: 'Oi teste',
  }).expect(303).expect('Location', '/messages?saved=1');

  assert.equal(calls.saveMessageSettings.length, 1);
  assert.equal(calls.saveMessageSettings[0].actor, 'admin');
  assert.equal(calls.saveMessageSettings[0].settings.steps.offer_greeting.text, 'Oi teste');
  assert.equal(calls.saveMessageSettings[0].settings.steps.offer_greeting.delayMs, 500);
});
