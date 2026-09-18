'use strict';

function integerId(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} inválido`);
  return parsed;
}

function money(value) {
  const text = String(value ?? '').trim().replace(',', '.');
  if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(text) || Number(text) <= 0) {
    throw new Error('Valor inválido');
  }
  return Number(text).toFixed(2);
}

function actorName(value) {
  const actor = String(value ?? '').trim();
  if (!actor || actor.length > 100) throw new Error('Operador inválido');
  return actor;
}

async function inTransaction(pool, operation) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function filterValues(filters = {}) {
  const from = filters.from && /^\d{4}-\d{2}-\d{2}$/.test(filters.from) ? filters.from : null;
  const to = filters.to && /^\d{4}-\d{2}-\d{2}$/.test(filters.to) ? filters.to : null;
  const search = String(filters.search ?? '').trim().slice(0, 100) || null;
  return [from, to, search];
}

function createSalesService(pool) {
  if (!pool || (typeof pool.query !== 'function' && typeof pool.connect !== 'function')) {
    throw new Error('Pool do banco é obrigatório');
  }

  return {
    async confirmPayment(input) {
      const saleId = integerId(input.saleId, 'Venda');
      const amount = money(input.amount);
      const actor = actorName(input.actor);

      return inTransaction(pool, async (client) => {
        const locked = await client.query(
          'SELECT id, contact_id, status FROM sales WHERE id = $1 FOR UPDATE',
          [saleId],
        );
        if (locked.rowCount === 0) throw new Error('Venda não encontrada');
        const sale = locked.rows[0];
        if (sale.status === 'paid') return { changed: false };

        await client.query(
          `UPDATE sales SET status = 'paid', confirmed_amount = $2, confirmed_by = $3,
             confirmed_at = NOW() WHERE id = $1`,
          [saleId, amount, actor],
        );
        await client.query(
          `UPDATE contacts SET state = 'paid', next_followup_at = NULL WHERE id = $1`,
          [sale.contact_id],
        );
        await client.query(
          `UPDATE followups SET status = 'cancelled'
             WHERE sale_id = $1 AND status IN ('pending', 'processing')`,
          [saleId],
        );
        await client.query(
          `INSERT INTO audit_log (actor, action, entity_type, entity_id, details)
           VALUES ($1, 'payment_confirmed', 'sale', $2, jsonb_build_object('amount', $3::text))`,
          [actor, saleId, amount],
        );
        await client.query(
          `INSERT INTO outbox (contact_id, message_type, payload, dedupe_key)
           VALUES ($1, 'payment_thanks', jsonb_build_object('saleId', $2::bigint), $3)
           ON CONFLICT (dedupe_key) DO NOTHING`,
          [sale.contact_id, saleId, `sale-paid:${saleId}`],
        );
        return { changed: true };
      });
    },

    async markUnpaid(input) {
      const saleId = integerId(input.saleId, 'Venda');
      const actor = actorName(input.actor);
      return inTransaction(pool, async (client) => {
        const locked = await client.query(
          'SELECT id, contact_id, status FROM sales WHERE id = $1 FOR UPDATE',
          [saleId],
        );
        if (locked.rowCount === 0) throw new Error('Venda não encontrada');
        const sale = locked.rows[0];
        if (sale.status === 'unpaid') return { changed: false };
        if (sale.status === 'paid') throw new Error('Venda paga não pode ser marcada como não paga');

        await client.query("UPDATE sales SET status = 'unpaid' WHERE id = $1", [saleId]);
        await client.query(
          "UPDATE contacts SET state = 'stopped', stopped_at = NOW(), next_followup_at = NULL WHERE id = $1",
          [sale.contact_id],
        );
        await client.query(
          "UPDATE followups SET status = 'cancelled' WHERE sale_id = $1 AND status IN ('pending', 'processing')",
          [saleId],
        );
        await client.query(
          `INSERT INTO audit_log (actor, action, entity_type, entity_id)
           VALUES ($1, 'payment_marked_unpaid', 'sale', $2)`,
          [actor, saleId],
        );
        return { changed: true };
      });
    },

    async setAutomationState(input) {
      const contactId = integerId(input.contactId, 'Contato');
      const actor = actorName(input.actor);
      if (!['stopped', 'awaiting_payment'].includes(input.state)) throw new Error('Estado inválido');

      return inTransaction(pool, async (client) => {
        const updated = await client.query(
          `UPDATE contacts SET state = $2,
             stopped_at = CASE WHEN $2 = 'stopped' THEN NOW() ELSE NULL END
           WHERE id = $1 RETURNING id`,
          [contactId, input.state],
        );
        if (updated.rowCount === 0) throw new Error('Contato não encontrado');
        if (input.state === 'stopped') {
          await client.query(
            "UPDATE followups SET status = 'cancelled' WHERE contact_id = $1 AND status IN ('pending', 'processing')",
            [contactId],
          );
        }
        await client.query(
          `INSERT INTO audit_log (actor, action, entity_type, entity_id, details)
           VALUES ($1, 'automation_state_changed', 'contact', $2, jsonb_build_object('state', $3::text))`,
          [actor, contactId, input.state],
        );
        return { changed: true };
      });
    },

    async listSummary(filters = {}) {
      const values = filterValues(filters);
      const conditions = `
        WHERE ($1::date IS NULL OR s.created_at >= $1::date)
          AND ($2::date IS NULL OR s.created_at < $2::date + INTERVAL '1 day')
          AND ($3::text IS NULL OR c.phone ILIKE '%' || $3 || '%' OR c.display_name ILIKE '%' || $3 || '%')`;
      const [summary, daily, contacts] = await Promise.all([
        pool.query(
          `SELECT COALESCE(SUM(s.confirmed_amount) FILTER (WHERE s.status = 'paid'), 0) AS revenue,
                  COUNT(*) FILTER (WHERE s.status = 'paid')::int AS paid,
                  COUNT(*) FILTER (WHERE s.status = 'pending')::int AS pending,
                  COUNT(DISTINCT c.id)::int AS contacts
             FROM sales s JOIN contacts c ON c.id = s.contact_id ${conditions}`,
          values,
        ),
        pool.query(
          `SELECT s.confirmed_at::date AS day, COUNT(*)::int AS sales,
                  COALESCE(SUM(s.confirmed_amount), 0) AS revenue
             FROM sales s JOIN contacts c ON c.id = s.contact_id ${conditions}
              AND s.status = 'paid' GROUP BY day ORDER BY day`,
          values,
        ),
        pool.query(
          `SELECT c.id, c.display_name, c.phone, c.state, s.id AS sale_id, s.status,
                  s.expected_amount, s.confirmed_amount, s.created_at, s.confirmed_at
             FROM sales s JOIN contacts c ON c.id = s.contact_id ${conditions}
            ORDER BY s.created_at DESC LIMIT 200`,
          values,
        ),
      ]);
      return { summary: summary.rows[0], daily: daily.rows, contacts: contacts.rows };
    },

    async getContact(contactIdValue) {
      const contactId = integerId(contactIdValue, 'Contato');
      const [contact, sales, messages, followups] = await Promise.all([
        pool.query('SELECT * FROM contacts WHERE id = $1', [contactId]),
        pool.query('SELECT * FROM sales WHERE contact_id = $1 ORDER BY created_at DESC', [contactId]),
        pool.query(
          'SELECT * FROM message_events WHERE contact_id = $1 ORDER BY event_at DESC LIMIT 100',
          [contactId],
        ),
        pool.query('SELECT * FROM followups WHERE contact_id = $1 ORDER BY sequence_number', [contactId]),
      ]);
      if (contact.rowCount === 0) return null;
      return { contact: contact.rows[0], sales: sales.rows, messages: messages.rows, followups: followups.rows };
    },
  };
}

module.exports = { createSalesService };
