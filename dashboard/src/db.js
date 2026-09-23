'use strict';

const { Pool } = require('pg');

function createPool(connectionString) {
  if (!connectionString) throw new Error('DATABASE_URL é obrigatória');
  const pool = new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    options: '--statement_timeout=10000',
  });
  pool.on('error', (error) => console.error('Erro inesperado no pool PostgreSQL:', error.message));
  return pool;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDatabase(pool, options = {}) {
  const attempts = Number(options.attempts || 30);
  const delayMs = Number(options.delayMs ?? 1000);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (error) {
      lastError = error;
      console.warn(`Postgres ainda não está pronto para o dashboard (${attempt}/${attempts}): ${error.message}`);
      if (attempt < attempts) await sleep(delayMs);
    }
  }
  throw lastError;
}

module.exports = { createPool, waitForDatabase };
