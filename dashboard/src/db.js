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

module.exports = { createPool };
