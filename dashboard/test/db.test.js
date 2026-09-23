'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { waitForDatabase } = require('../src/db');

test('waitForDatabase retries until Postgres accepts connections', async () => {
  let calls = 0;
  const pool = {
    async query() {
      calls += 1;
      if (calls < 3) throw new Error('the database system is starting up');
      return { rows: [{ '?column?': 1 }] };
    },
  };

  await waitForDatabase(pool, { attempts: 3, delayMs: 0 });

  assert.equal(calls, 3);
});

test('waitForDatabase throws the last error after all attempts fail', async () => {
  const pool = {
    async query() {
      throw new Error('the database system is starting up');
    },
  };

  await assert.rejects(
    waitForDatabase(pool, { attempts: 2, delayMs: 0 }),
    /the database system is starting up/,
  );
});
