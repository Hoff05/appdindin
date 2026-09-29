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
  const calls = { confirmPayment: [], markUnpaid: [], setAutomationState: [] };
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

test('dashboard shell preserves filters, csrf logout, chart data and client links', async () => {
  const { app } = makeApp();
  const agent = request.agent(app);
  await login(agent).then((response) => assert.equal(response.status, 303));

  const dashboard = await agent.get('/?from=2026-09-01&to=2026-09-30&search=Maria').expect(200);
  assert.match(dashboard.text, /class="dashboard-shell"/);
  assert.match(dashboard.text, /class="sidebar"/);
  assert.match(dashboard.text, /method="get" action="\/"/);
  assert.match(dashboard.text, /name="from" value="2026-09-01"/);
  assert.match(dashboard.text, /name="to" value="2026-09-30"/);
  assert.match(dashboard.text, /name="search" value="Maria"/);
  assert.match(dashboard.text, /action="\/logout" method="post"/);
  assert.match(dashboard.text, /name="_csrf" value="[^"]+"/);
  assert.match(dashboard.text, /id="sales-chart" class="chart"/);
  assert.match(dashboard.text, /data-series="\[{&#34;day&#34;:&#34;2026-09-18&#34;/);
  assert.match(dashboard.text, /href="\/contacts\/3"/);
});

test('pages expose the brand logo and installable app metadata', async () => {
  const { app } = makeApp();
  const agent = request.agent(app);
  await login(agent).then((response) => assert.equal(response.status, 303));

  const dashboard = await agent.get('/').expect(200);
  assert.match(dashboard.text, /rel="icon" href="\/static\/logo.png"/);
  assert.match(dashboard.text, /rel="apple-touch-icon" href="\/static\/logo.png"/);
  assert.match(dashboard.text, /rel="manifest" href="\/static\/site.webmanifest"/);
  assert.match(dashboard.text, /<img class="brand-logo" src="\/static\/logo.png" alt="Universo Pedagógico">/);
  assert.match(dashboard.text, /\/static\/app\.css\?v=20260928-logo-fix-v1/);

  const contact = await agent.get('/contacts/3').expect(200);
  assert.match(contact.text, /<img class="brand-logo" src="\/static\/logo.png" alt="Universo Pedagógico">/);
  assert.match(contact.text, /\/static\/app\.css\?v=20260928-logo-fix-v1/);

  await agent.get('/static/logo.png').expect(200).expect('Content-Type', /image\/png/);
  const css = await agent.get('/static/app.css?v=20260928-logo-fix-v1').expect(200);
  assert.match(css.text, /\.brand-logo\{[^}]*width:100%[^}]*height:100%[^}]*max-width:100%[^}]*max-height:100%[^}]*object-fit:cover[^}]*display:block/);
  const manifest = await agent.get('/static/site.webmanifest').expect(200);
  assert.match(manifest.text, /"src":"\/static\/logo\.png"/);
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

test('contact detail page keeps payment and automation actions inside the premium shell', async () => {
  const { app } = makeApp();
  const agent = request.agent(app);
  await login(agent).then((response) => assert.equal(response.status, 303));

  const contact = await agent.get('/contacts/3').expect(200);
  assert.match(contact.text, /class="contact-page"/);
  assert.match(contact.text, /class="contact-shell"/);
  assert.match(contact.text, /class="contact-hero"/);
  assert.match(contact.text, /href="https:\/\/wa.me\/5511999999999"/);
  assert.match(contact.text, /action="\/contacts\/3\/automation" method="post"/);
  assert.match(contact.text, /name="state" value="stopped"/);
  assert.match(contact.text, /name="state" value="awaiting_payment"/);
  assert.match(contact.text, /action="\/sales\/7\/confirm" method="post"/);
  assert.match(contact.text, /name="contactId" value="3"/);
  assert.match(contact.text, /name="amount" inputmode="decimal" value="9.90"/);
  assert.match(contact.text, /action="\/sales\/7\/unpaid" method="post"/);
  assert.match(contact.text, /name="_csrf" value="[^"]+"/);
});

test('unknown contacts return 404 after authentication', async () => {
  const { app } = makeApp();
  const agent = request.agent(app);
  await login(agent).then((response) => assert.equal(response.status, 303));
  await agent.get('/contacts/999').expect(404);
});

