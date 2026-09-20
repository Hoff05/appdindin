'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSalesService } = require('../src/domain/sales');

function makeRecordingPool(initialSale) {
  const queries = [];
  const sale = { ...initialSale };

  const client = {
    async query(sql, params = []) {
      const normalized = String(sql).trim().replace(/\s+/g, ' ');
      queries.push({ sql: normalized, params });

      if (/^SELECT .* FROM sales .* FOR UPDATE$/i.test(normalized)) {
        return { rows: sale.id ? [{ ...sale }] : [], rowCount: sale.id ? 1 : 0 };
      }
      if (/^UPDATE sales SET status = 'paid'/i.test(normalized)) sale.status = 'paid';
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };

  return {
    pool: { async connect() { return client; } },
    queries,
    commands() {
      return queries.filter(({ sql }) => ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)).map(({ sql }) => sql);
    },
    matching(pattern) {
      return queries.filter(({ sql }) => pattern.test(sql));
    },
  };
}

test('confirmPayment atomically pays a sale and queues one thank-you', async () => {
  const db = makeRecordingPool({ id: 7, contact_id: 3, status: 'pending' });
  const service = createSalesService(db.pool);

  assert.deepEqual(
    await service.confirmPayment({ saleId: 7, amount: '9.90', actor: 'admin' }),
    { changed: true },
  );
  assert.deepEqual(db.commands(), ['BEGIN', 'COMMIT']);
  assert.equal(db.matching(/^UPDATE contacts SET state = 'paid'/i).length, 1);
  assert.equal(db.matching(/^UPDATE followups SET status = 'cancelled'/i).length, 1);
  assert.equal(db.matching(/^INSERT INTO audit_log/i).length, 1);
  assert.equal(db.matching(/^INSERT INTO outbox/i).length, 1);
  assert.match(db.matching(/^INSERT INTO outbox/i)[0].sql, /ON CONFLICT \(dedupe_key\) DO NOTHING/i);
  assert.match(db.matching(/^INSERT INTO outbox/i)[0].sql, /jsonb_build_object\('saleId', \$2::bigint\)/i);
});

test('confirmPayment is idempotent for an already paid sale', async () => {
  const db = makeRecordingPool({ id: 7, contact_id: 3, status: 'paid' });
  const service = createSalesService(db.pool);

  assert.deepEqual(
    await service.confirmPayment({ saleId: 7, amount: '9.90', actor: 'admin' }),
    { changed: false },
  );
  assert.equal(db.matching(/^INSERT INTO outbox/i).length, 0);
  assert.deepEqual(db.commands(), ['BEGIN', 'COMMIT']);
});

test('confirmPayment rejects invalid money without opening a transaction', async () => {
  const db = makeRecordingPool({ id: 7, contact_id: 3, status: 'pending' });
  const service = createSalesService(db.pool);

  await assert.rejects(
    service.confirmPayment({ saleId: 7, amount: '-1', actor: 'admin' }),
    /valor inválido/i,
  );
  assert.equal(db.queries.length, 0);
});

test('setAutomationState accepts only stopped or awaiting_payment', async () => {
  const service = createSalesService({ query: async () => ({ rows: [], rowCount: 1 }) });

  await assert.rejects(
    service.setAutomationState({ contactId: 3, state: 'paid', actor: 'admin' }),
    /estado inválido/i,
  );
});


test('saveMessageSettings stores message JSON and follow-up delays', async () => {
  const queries = [];
  const service = createSalesService({
    async query(sql, params = []) { queries.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params }); return { rows: [], rowCount: 1 }; },
  });

  await service.saveMessageSettings({
    actor: 'admin',
    settings: { steps: {}, followups: { first: { delayMinutes: 5 }, second: { delayMinutes: 10 }, third: { delayMinutes: 15 } } },
  });

  assert.ok(queries.some((query) => /message_settings/.test(query.sql)));
  assert.ok(queries.some((query) => /followup_minutes/.test(query.sql) && query.params[0] === '5,10,15'));
  assert.ok(queries.some((query) => /message_settings_saved/.test(query.sql)));
});
