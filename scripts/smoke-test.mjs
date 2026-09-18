import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

const requireFromDashboard = createRequire(import.meta.url);
const { Pool } = requireFromDashboard('pg');
const testPhone = '5511999999999';
const dashboardUrl = 'http://localhost:3000';

async function loadLocalEnv() {
  if (process.env.DATABASE_URL && process.env.DASHBOARD_USER) return;

  try {
    const source = await readFile(resolve('.env'), 'utf8');
    for (const line of source.split(/\r?\n/)) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (match && process.env[match[1]] == null) process.env[match[1]] = match[2];
    }
  } catch {
    throw new Error('Arquivo .env não encontrado. Execute scripts/setup.ps1 primeiro.');
  }
}

function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const user = encodeURIComponent(process.env.POSTGRES_USER || '');
  const password = encodeURIComponent(process.env.POSTGRES_PASSWORD || '');
  const database = encodeURIComponent(process.env.POSTGRES_DB || '');
  return `postgresql://${user}:${password}@localhost:5432/${database}`;
}

async function cleanup(pool) {
  const contacts = await pool.query("SELECT DISTINCT contact_id FROM message_events WHERE external_id LIKE 'smoke:%' AND contact_id IS NOT NULL");
  const ids = contacts.rows.map((row) => row.contact_id);
  if (ids.length) await pool.query('DELETE FROM contacts WHERE id = ANY($1::bigint[])', [ids]);
  await pool.query("DELETE FROM message_events WHERE external_id LIKE 'smoke:%'");
}

async function seed(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const contact = await client.query(
      `INSERT INTO contacts (whatsapp_id, phone, display_name, state, consented_at)
       VALUES ($1, $2, 'Teste local', 'awaiting_payment', NOW()) RETURNING id`,
      [`smoke:${testPhone}@s.whatsapp.net`, testPhone],
    );
    const contactId = contact.rows[0].id;
    await client.query(
      `INSERT INTO message_events (external_id, contact_id, direction, message_type, content_summary, event_at)
       VALUES ('smoke:message:1', $1, 'incoming', 'text', 'Teste local', NOW())`,
      [contactId],
    );
    const sale = await client.query(
      "INSERT INTO sales (contact_id, expected_amount, status) VALUES ($1, 9.90, 'pending') RETURNING id",
      [contactId],
    );
    for (const [index, minutes] of [15, 60, 91].entries()) {
      await client.query(
        `INSERT INTO followups (contact_id, sale_id, sequence_number, scheduled_at)
         VALUES ($1, $2, $3, NOW() + ($4 || ' minutes')::interval)`,
        [contactId, sale.rows[0].id, index + 1, minutes],
      );
    }
    await client.query('COMMIT');
    return { contactId, saleId: sale.rows[0].id };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function csrf(html) {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  if (!match) throw new Error('Token CSRF não encontrado no dashboard.');
  return match[1];
}

function cookie(response) {
  const values = response.headers.getSetCookie?.() || [response.headers.get('set-cookie')].filter(Boolean);
  if (!values.length) throw new Error('Cookie de sessão não recebido.');
  return values.map((value) => value.split(';')[0]).join('; ');
}

async function waitForDashboard() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`${dashboardUrl}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
  }
  throw new Error('Dashboard não ficou saudável em 30 segundos.');
}

async function confirmThroughDashboard({ contactId, saleId }) {
  const loginPage = await fetch(`${dashboardUrl}/login`);
  let sessionCookie = cookie(loginPage);
  const loginBody = await loginPage.text();
  const loginResponse = await fetch(`${dashboardUrl}/login`, {
    method: 'POST', redirect: 'manual', headers: { Cookie: sessionCookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      _csrf: csrf(loginBody),
      username: process.env.DASHBOARD_USER,
      password: process.env.DASHBOARD_TEST_PASSWORD || 'troque-esta-senha',
    }),
  });
  if (loginResponse.status !== 303) throw new Error(`Login de teste falhou com HTTP ${loginResponse.status}.`);
  sessionCookie = cookie(loginResponse);

  const detail = await fetch(`${dashboardUrl}/contacts/${contactId}`, { headers: { Cookie: sessionCookie } });
  const detailBody = await detail.text();
  const confirmation = await fetch(`${dashboardUrl}/sales/${saleId}/confirm`, {
    method: 'POST', redirect: 'manual', headers: { Cookie: sessionCookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf(detailBody), contactId: String(contactId), amount: '9.90' }),
  });
  if (confirmation.status !== 303) throw new Error(`Confirmação falhou com HTTP ${confirmation.status}.`);
}

await loadLocalEnv();
await waitForDashboard();
const pool = new Pool({ connectionString: databaseUrl() });
try {
  await cleanup(pool);
  const ids = await seed(pool);
  await confirmThroughDashboard(ids);
  const result = await pool.query(
    `SELECT s.status, c.state,
       (SELECT COUNT(*)::int FROM followups WHERE sale_id = s.id AND status = 'cancelled') AS cancelled,
       (SELECT COUNT(*)::int FROM audit_log WHERE entity_type = 'sale' AND entity_id = s.id AND action = 'payment_confirmed') AS audits,
       (SELECT COUNT(*)::int FROM outbox WHERE dedupe_key = 'sale-paid:' || s.id) AS outbox
     FROM sales s JOIN contacts c ON c.id = s.contact_id WHERE s.id = $1`,
    [ids.saleId],
  );
  const row = result.rows[0];
  if (row.status !== 'paid' || row.state !== 'paid' || row.cancelled !== 3 || row.audits !== 1 || row.outbox !== 1) {
    throw new Error(`Resultado inesperado: ${JSON.stringify(row)}`);
  }
  console.log('Smoke test aprovado: confirmação idempotente, lembretes cancelados e agradecimento enfileirado.');
} finally {
  await cleanup(pool);
  await pool.end();
}
