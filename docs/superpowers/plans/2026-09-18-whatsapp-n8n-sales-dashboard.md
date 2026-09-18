# WhatsApp n8n Sales Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Docker Desktop stack that connects WhatsApp by QR Code, delivers a configurable mathematics kit through n8n, requests a fixed Pix payment, and tracks manually confirmed revenue in a protected dashboard.

**Architecture:** Docker Compose runs PostgreSQL, Evolution API 2.3.7, n8n 2.39.7, and a Node.js dashboard on one private network. PostgreSQL is the shared source of truth; n8n writes message state and consumes an outbox, while the dashboard performs transactional payment actions and reports aggregated sales.

**Tech Stack:** Docker Compose, PostgreSQL 16, Evolution API 2.3.7, n8n 2.39.7, Node.js 22, Express 5, EJS, `pg`, `express-session`, `connect-pg-simple`, Node test runner, Supertest.

**Spec:** `docs/superpowers/specs/2026-09-18-whatsapp-n8n-sales-dashboard-design.md`

## Global Constraints

- The WhatsApp connection uses Evolution API and QR Code, not Meta Cloud API.
- A payment becomes paid only after a dashboard operator confirms it.
- Materials remain configurable and are not copied from the supplied video.
- Incoming duplicate events, repeated dashboard actions, and repeated outbox polling must be idempotent.
- Automatic follow-ups stop after payment, opt-out, or a message requiring human attention.
- The default follow-up schedule is 15 minutes, 2 hours, and 24 hours, with at most three messages.
- Credentials and personal data must stay out of Git.
- The application timezone is `America/Sao_Paulo`.
- The local dashboard and n8n ports are published; PostgreSQL stays private to the Compose network.

---

### Task 1: Reproducible Docker foundation and database schema

**Files:**
- Create: `.gitignore`
- Create: `.env.example`
- Create: `compose.yaml`
- Create: `database/init/001_schema.sql`
- Create: `materials/manifest.example.json`
- Create: `scripts/validate-config.mjs`
- Test: `tests/config.test.mjs`

**Interfaces:**
- Consumes: No project code.
- Produces: Compose services named `postgres`, `evolution-api`, `n8n`, and `dashboard`; PostgreSQL tables `contacts`, `message_events`, `sales`, `followups`, `audit_log`, and `outbox`; `materials/manifest.json` schema `{ offerImage, documents, driveUrl }`.

- [ ] **Step 1: Write configuration tests**

Create `tests/config.test.mjs` using `node:test`. Assert that `compose.yaml` contains all four service names, does not publish PostgreSQL port 5432, pins `evoapicloud/evolution-api:v2.3.7` and `n8nio/n8n:2.39.7`, mounts materials read-only, and that the example manifest has exactly nine ordered PDF entries.

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('compose pins required services without exposing postgres', async () => {
  const yaml = await readFile(new URL('../compose.yaml', import.meta.url), 'utf8');
  for (const name of ['postgres:', 'evolution-api:', 'n8n:', 'dashboard:']) assert.match(yaml, new RegExp(`\\n  ${name}`));
  assert.match(yaml, /evoapicloud\/evolution-api:v2\.3\.7/);
  assert.match(yaml, /n8nio\/n8n:2\.39\.7/);
  assert.doesNotMatch(yaml, /5432:5432/);
  assert.match(yaml, /materials:\/files:ro/);
});

test('material manifest defines nine ordered PDFs', async () => {
  const manifest = JSON.parse(await readFile(new URL('../materials/manifest.example.json', import.meta.url), 'utf8'));
  assert.equal(manifest.documents.length, 9);
  assert.deepEqual(manifest.documents.map((item) => item.order), [1,2,3,4,5,6,7,8,9]);
});
```

- [ ] **Step 2: Run tests and confirm the expected failure**

Run: `node --test tests/config.test.mjs`

Expected: FAIL because `compose.yaml` and the manifest do not exist.

- [ ] **Step 3: Add schema and configuration files**

Implement `database/init/001_schema.sql` with enum-like `CHECK` constraints, foreign keys, UTC timestamps, a unique `message_events.external_id`, one active sale per contact through a partial unique index, unique `(contact_id, sequence_number)` follow-ups, and unique `outbox.dedupe_key`. Add `updated_at` triggers for contacts and sales.

Create `compose.yaml` with health checks and named volumes. Use `postgres:16-alpine`, `evoapicloud/evolution-api:v2.3.7`, `n8nio/n8n:2.39.7`, and build `dashboard/`. Evolution and n8n depend on healthy PostgreSQL. Mount `./materials:/files:ro` into n8n.

Create `.env.example` with local example values, including:

```dotenv
TZ=America/Sao_Paulo
POSTGRES_DB=zap_sales
POSTGRES_USER=zap_app
POSTGRES_PASSWORD=local-development-password-change-before-sharing
EVOLUTION_API_KEY=local-evolution-key-change-before-sharing
EVOLUTION_INSTANCE=kit-matematica
N8N_ENCRYPTION_KEY=local-n8n-encryption-key-change-before-sharing-32
DASHBOARD_USER=admin
DASHBOARD_PASSWORD_SCRYPT=scrypt$16384$8$1$Y29kZXgtbG9jYWwtc2FsdA==$47ff82ff4f0ed1be856f57500c542448266a7691593094365ea084a1fa44749ce5236512093daaa8d1cb32667d77e6db2ba1b9260020fac90346487675032648
SESSION_SECRET=local-session-secret-change-before-sharing
PIX_KEY=
PIX_KEY_TYPE=telefone
PIX_RECEIVER_NAME=
PRODUCT_PRICE=9.90
MATERIALS_DRIVE_URL=
FOLLOWUP_MINUTES=15,120,1440
```

Create `materials/manifest.example.json` with `offerImage: "oferta.jpg"`, document filenames `atividades-1-ano.pdf` through `atividades-9-ano.pdf`, display names in Portuguese, and an empty `driveUrl`.

Create `.gitignore` for `.env`, `materials/manifest.json`, actual images/PDFs, `node_modules`, coverage, analysis artifacts, and local volumes.

- [ ] **Step 4: Implement and run the configuration validator**

`scripts/validate-config.mjs` must load a manifest path passed as argv, require nine unique orders 1-9, require `.pdf` extensions, reject absolute or parent-traversal paths, and report every missing material. Export `validateManifest(manifest, materialRoot)` for tests and exit nonzero from CLI on errors.

Run: `node --test tests/config.test.mjs`

Expected: PASS.

Run: `docker compose --env-file .env.example config --quiet`

Expected: exit 0 when Docker Compose is available.

- [ ] **Step 5: Commit the foundation**

```bash
git add .gitignore .env.example compose.yaml database materials scripts/validate-config.mjs tests/config.test.mjs
git commit -m "feat: add Docker foundation and sales schema"
```

---

### Task 2: Dashboard domain layer and transactional sale operations

**Files:**
- Create: `dashboard/package.json`
- Create: `dashboard/Dockerfile`
- Create: `dashboard/src/db.js`
- Create: `dashboard/src/domain/sales.js`
- Create: `dashboard/test/sales.test.js`

**Interfaces:**
- Consumes: Tables from Task 1 and a `pg.Pool` compatible object.
- Produces: `createSalesService(pool)` with `listSummary(filters)`, `getContact(contactId)`, `confirmPayment(input)`, `markUnpaid(input)`, and `setAutomationState(input)`.

- [ ] **Step 1: Define failing domain tests**

Use `node:test` with a recording fake client. Verify that `confirmPayment({ saleId: 7, amount: '9.90', actor: 'admin' })` begins a transaction, locks the sale, updates it only when not already paid, moves the contact to `paid`, cancels pending follow-ups, inserts an audit row, creates one outbox row with dedupe key `sale-paid:7`, and commits. Verify a repeated call returns `{ changed: false }` without duplicating the outbox.

```js
test('confirmPayment atomically pays a sale and queues one thank-you', async () => {
  const db = makeRecordingPool({ sale: { id: 7, contact_id: 3, status: 'pending' } });
  const service = createSalesService(db.pool);
  assert.deepEqual(await service.confirmPayment({ saleId: 7, amount: '9.90', actor: 'admin' }), { changed: true });
  assert.deepEqual(db.transactionCommands(), ['BEGIN', 'COMMIT']);
  assert.equal(db.insertsInto('outbox').length, 1);
  assert.match(db.insertsInto('outbox')[0].sql, /ON CONFLICT \(dedupe_key\) DO NOTHING/);
});
```

- [ ] **Step 2: Run the domain test and verify failure**

Run: `cd dashboard && npm test -- --test-name-pattern=confirmPayment`

Expected: FAIL because `createSalesService` is missing.

- [ ] **Step 3: Implement database and sales service**

`dashboard/src/db.js` exports `createPool(connectionString)` with bounded connections, statement timeout, and shutdown handling.

`dashboard/src/domain/sales.js` must use parameterized SQL exclusively. `confirmPayment` validates a positive decimal with at most two fraction digits, runs `SELECT ... FOR UPDATE`, handles already-paid sales idempotently, and performs all related writes before commit. `setAutomationState` accepts only `stopped` or `awaiting_payment`. `listSummary` returns cards, daily series, and contacts in one service result while applying validated date and search filters.

- [ ] **Step 4: Run all dashboard domain tests**

Run: `cd dashboard && npm test`

Expected: PASS with transaction, validation, and idempotency cases covered.

- [ ] **Step 5: Commit the domain layer**

```bash
git add dashboard/package.json dashboard/Dockerfile dashboard/src/db.js dashboard/src/domain/sales.js dashboard/test/sales.test.js
git commit -m "feat: add transactional sales domain"
```

---

### Task 3: Protected dashboard and payment management UI

**Files:**
- Create: `dashboard/src/auth.js`
- Create: `dashboard/src/app.js`
- Create: `dashboard/src/server.js`
- Create: `dashboard/src/routes/dashboard.js`
- Create: `dashboard/src/routes/sales.js`
- Create: `dashboard/src/views/login.ejs`
- Create: `dashboard/src/views/dashboard.ejs`
- Create: `dashboard/src/views/contact.ejs`
- Create: `dashboard/src/public/app.css`
- Create: `dashboard/src/public/chart.js`
- Test: `dashboard/test/app.test.js`

**Interfaces:**
- Consumes: `createSalesService(pool)` from Task 2 and env variables `DASHBOARD_USER`, `DASHBOARD_PASSWORD_SCRYPT`, `SESSION_SECRET`.
- Produces: `createApp({ salesService, sessionStore, authConfig })`; HTTP routes `GET/POST /login`, `POST /logout`, `GET /`, `GET /contacts/:id`, `POST /sales/:id/confirm`, `POST /sales/:id/unpaid`, and `POST /contacts/:id/automation`.

- [ ] **Step 1: Write failing HTTP tests**

Use Supertest agents. Assert unauthenticated `/` redirects to `/login`; wrong credentials return 401; correct credentials create a session; POST actions without the per-session CSRF token return 403; a valid confirm request calls `confirmPayment` once and redirects to the contact page; repeated confirmation remains successful.

```js
test('authenticated operator confirms a pending payment', async () => {
  const agent = request.agent(createTestApp());
  await login(agent);
  const page = await agent.get('/contacts/3').expect(200);
  const token = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
  await agent.post('/sales/7/confirm').type('form').send({ _csrf: token, amount: '9.90' }).expect(303);
  assert.deepEqual(calls.confirmPayment[0], { saleId: 7, amount: '9.90', actor: 'admin' });
});
```

- [ ] **Step 2: Run HTTP tests and verify failure**

Run: `cd dashboard && npm test -- --test-name-pattern=authenticated`

Expected: FAIL because the Express application is missing.

- [ ] **Step 3: Implement authentication and route protections**

Parse the scrypt string as `algorithm$N$r$p$saltBase64$hashHex`, derive with `crypto.scrypt`, and compare with `timingSafeEqual`. Regenerate the session after login. Generate a random CSRF token per session, place it in every mutation form, and reject mismatches. Cookies must be `HttpOnly`, `SameSite=Lax`, and `Secure` only when `DASHBOARD_SECURE_COOKIE=true`.

- [ ] **Step 4: Implement responsive views and local chart**

Render four summary cards, a dependency-free SVG daily chart, filters, and the contact table. The detail view must show message/follow-up history and forms for confirmation, marking unpaid, stopping/reactivating automation, plus a `https://wa.me/<digits>` link. Keep all product copy in Portuguese and make the layout usable at 360px width.

- [ ] **Step 5: Run tests and perform accessibility smoke checks**

Run: `cd dashboard && npm test`

Expected: PASS.

Run the app with a fake service test fixture and verify responses contain one `<h1>`, associated form labels, visible focus styles, and no inline secrets.

- [ ] **Step 6: Commit the dashboard**

```bash
git add dashboard
git commit -m "feat: add protected sales dashboard"
```

---

### Task 4: Incoming WhatsApp conversation workflow

**Files:**
- Create: `automation/workflows/01-whatsapp-inbound.json`
- Create: `automation/fixtures/messages-upsert-text.json`
- Create: `automation/fixtures/messages-upsert-image.json`
- Create: `automation/scripts/validate-workflow.mjs`
- Test: `automation/test/inbound-workflow.test.mjs`

**Interfaces:**
- Consumes: Evolution webhook payloads, PostgreSQL schema from Task 1, files under `/files`, and env `EVOLUTION_API_KEY`, `EVOLUTION_INSTANCE`, `PRODUCT_PRICE`, `PIX_*`.
- Produces: n8n webhook path `/webhook/evolution/messages`; contact transitions; calls to Evolution endpoints `/message/sendText/:instance` and `/message/sendMedia/:instance`.

- [ ] **Step 1: Write structural and behavioral workflow tests**

Create fixtures from the documented Evolution `MESSAGES_UPSERT` shape. Assert the workflow contains Webhook, normalization Code, PostgreSQL idempotency insert, intent Switch, offer branch, consent branch, opt-out branch, receipt branch, and an explicit response node. Assert every Evolution HTTP node sends the `apikey` header and uses the internal URL `http://evolution-api:8080`.

```js
test('inbound workflow has idempotency before every sending branch', async () => {
  const flow = JSON.parse(await readFile(flowUrl, 'utf8'));
  const names = new Set(flow.nodes.map((node) => node.name));
  for (const required of ['Webhook Evolution', 'Normalize Event', 'Insert Event Once', 'Route State', 'Send Offer', 'Send Materials', 'Stop Automation']) assert.ok(names.has(required));
  assert.ok(reachable(flow, 'Insert Event Once', 'Send Offer'));
  assert.equal(reachable(flow, 'Webhook Evolution', 'Send Offer', { without: 'Insert Event Once' }), false);
});
```

- [ ] **Step 2: Run workflow tests and verify failure**

Run: `node --test automation/test/inbound-workflow.test.mjs`

Expected: FAIL because the workflow JSON is missing.

- [ ] **Step 3: Implement normalization and state routing**

Normalize external event id, instance, remote JID, digits-only phone, display name, from-me flag, group flag, message type, text, media reference, and timestamp. Return immediately for groups, own messages, empty status events, and duplicate external ids.

Use parameterized PostgreSQL nodes to upsert the contact and route using the current state plus normalized text. Intent matching must handle accents and only treat standalone affirmative/negative phrases as consent decisions.

- [ ] **Step 4: Implement offer, materials, Pix, opt-out, and receipt branches**

Offer messages use short Wait nodes between sends. Consent changes the state before reading `manifest.json`, verifies all configured files, and sends the offer image plus nine documents in manifest order. A completed material sequence creates a pending sale and three follow-up rows. Pix messages interpolate configured values, not video data.

An image received in `awaiting_payment` stores its Evolution media reference on the sale and sends a message explaining that confirmation is manual. Opt-out updates contact and pending follow-ups in one SQL statement and replies once.

- [ ] **Step 5: Validate workflow JSON and fixtures**

Run: `node automation/scripts/validate-workflow.mjs automation/workflows/01-whatsapp-inbound.json`

Expected: `valid: 01-whatsapp-inbound.json`.

Run: `node --test automation/test/inbound-workflow.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit the inbound workflow**

```bash
git add automation
git commit -m "feat: add WhatsApp sales conversation workflow"
```

---

### Task 5: Follow-up scheduler and dashboard outbox workflows

**Files:**
- Create: `automation/workflows/02-payment-followups.json`
- Create: `automation/workflows/03-dashboard-outbox.json`
- Test: `automation/test/scheduled-workflows.test.mjs`

**Interfaces:**
- Consumes: `followups`, `contacts`, `sales`, and `outbox`; Evolution send-text endpoint.
- Produces: exactly-once reminder attempts, cancelled ineligible reminders, and exactly-once dashboard-requested messages.

- [ ] **Step 1: Write failing scheduler tests**

Assert the follow-up workflow starts every minute, claims rows with `FOR UPDATE SKIP LOCKED`, rechecks `contacts.state = 'awaiting_payment'` and `sales.status = 'pending'`, marks skipped rows `cancelled`, and records send errors without losing the row. Assert the outbox workflow claims pending rows, sends by payload type, and marks `sent_at` only after HTTP success.

- [ ] **Step 2: Run scheduler tests and verify failure**

Run: `node --test automation/test/scheduled-workflows.test.mjs`

Expected: FAIL because both workflow files are missing.

- [ ] **Step 3: Implement the payment follow-up workflow**

Claim at most 20 due rows per minute. Send sequence-specific Portuguese copy for 15 minutes, 2 hours, and 24 hours. On success set `sent_at`; on non-retryable failure store `failed_at` and `last_error`; on temporary HTTP failure let n8n retry with increasing waits. Never create follow-ups beyond sequence 3.

- [ ] **Step 4: Implement the dashboard outbox workflow**

Claim pending outbox messages by id, support `payment_thanks` payloads, send the thank-you text, and set `sent_at`. Use the unique dedupe key created by Task 2 so repeated dashboard actions cannot enqueue duplicates.

- [ ] **Step 5: Run all workflow tests and commit**

Run: `node --test automation/test/*.test.mjs`

Expected: PASS.

```bash
git add automation/workflows/02-payment-followups.json automation/workflows/03-dashboard-outbox.json automation/test/scheduled-workflows.test.mjs
git commit -m "feat: add payment reminders and outbox delivery"
```

---

### Task 6: Import, setup, and end-to-end verification tooling

**Files:**
- Create: `scripts/setup.ps1`
- Create: `scripts/import-workflows.ps1`
- Create: `scripts/smoke-test.mjs`
- Create: `README.md`
- Test: `tests/smoke.test.mjs`

**Interfaces:**
- Consumes: All prior Compose services and workflow JSON files.
- Produces: repeatable local setup, documented QR connection, workflow import, configuration validation, backup, and a non-destructive simulated funnel smoke test.

- [ ] **Step 1: Write failing smoke-tool tests**

Assert `setup.ps1` refuses to overwrite an existing `.env`, creates `materials/manifest.json` only when absent, and prints the URLs `http://localhost:5678`, `http://localhost:8080/manager`, and `http://localhost:3000`. Assert `smoke-test.mjs` uses test phone `5511999999999`, never calls a public URL, and cleans only rows whose external ids start with `smoke:`.

- [ ] **Step 2: Run smoke-tool tests and verify failure**

Run: `node --test tests/smoke.test.mjs`

Expected: FAIL because the scripts are missing.

- [ ] **Step 3: Implement setup and workflow import scripts**

`setup.ps1` copies example files only when destinations do not exist, validates Docker availability, validates the manifest, and starts Compose. It must never print secret values. `import-workflows.ps1` runs n8n's import command inside the container for all three JSON files and reports imported workflow names.

- [ ] **Step 4: Implement the non-destructive smoke test**

Insert a deterministic pending test sale for the test phone directly through parameterized SQL, log in to the running dashboard over `http://localhost:3000`, extract its CSRF token, and submit the normal payment-confirmation form. Verify `paid`, cancelled follow-ups, one audit row, and one outbox row, then delete only rows whose external ids start with `smoke:`. Workflow fixtures in Tasks 4 and 5 cover simulated webhook events without sending real WhatsApp messages.

- [ ] **Step 5: Write operator documentation**

Document prerequisites, first-run commands, QR connection, Evolution webhook registration, adding the image/PDFs, importing and activating workflows, dashboard login, payment confirmation, stopping automation, backups, updates, troubleshooting, and the risk of QR-based unofficial WhatsApp integration. Include exact commands for `docker compose up -d`, `docker compose ps`, `docker compose logs`, database backup, and restore.

- [ ] **Step 6: Run the full verification suite**

Run:

```text
node --test tests/*.test.mjs automation/test/*.test.mjs
cd dashboard && npm test
docker compose --env-file .env.example config --quiet
node scripts/validate-config.mjs materials/manifest.example.json
```

Expected: all tests pass; Compose config exits 0; manifest validation reports missing user-selected files as configuration warnings and exits 0 only with `--allow-missing-files`.

When Docker Desktop is running, start the stack and require all health checks to pass. Run the smoke test without a connected WhatsApp session, then connect a dedicated test number by QR and perform one manual end-to-end conversation.

- [ ] **Step 7: Commit setup and documentation**

```bash
git add scripts README.md tests/smoke.test.mjs
git commit -m "docs: add setup and end-to-end verification"
```

---

### Task 7: Final security and release review

**Files:**
- Modify: any file identified by the review
- Create: `docs/operations-checklist.md`

**Interfaces:**
- Consumes: Completed stack.
- Produces: A release candidate with recorded verification results and no committed credentials or customer data.

- [ ] **Step 1: Scan the repository**

Run `git grep` for the real Pix key, phone numbers from the supplied video, `apikey`, `password`, and private media references. Confirm only environment variable names and local example values remain. Run `git status --short --ignored` and verify `.env`, PDFs, images, local databases, and analysis files are ignored.

- [ ] **Step 2: Review service exposure and authorization**

Confirm PostgreSQL is not published, dashboard mutations require authentication and CSRF, n8n and Evolution credentials are not embedded in workflow JSON, SQL values are parameterized, and logs redact tokens and receipt payloads.

- [ ] **Step 3: Record release verification**

Create `docs/operations-checklist.md` with dated results for tests, Compose validation, container health, QR connection, inbound offer, material delivery using safe sample PDFs, opt-out, receipt capture, dashboard confirmation, reminder cancellation, and backup restore.

- [ ] **Step 4: Commit the release review**

```bash
git add docs/operations-checklist.md
git commit -m "chore: complete release readiness review"
```
