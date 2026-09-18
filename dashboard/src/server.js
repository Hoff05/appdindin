'use strict';

const session = require('express-session');
const connectPgSimple = require('connect-pg-simple');
const { createApp } = require('./app');
const { createPool } = require('./db');
const { createSalesService } = require('./domain/sales');

const pool = createPool(process.env.DATABASE_URL);
const PgStore = connectPgSimple(session);
const store = new PgStore({ pool, tableName: 'dashboard_sessions', createTableIfMissing: true });
const app = createApp({
  salesService: createSalesService(pool),
  sessionStore: store,
  authConfig: {
    username: process.env.DASHBOARD_USER,
    passwordHash: process.env.DASHBOARD_PASSWORD_SCRYPT,
    sessionSecret: process.env.SESSION_SECRET,
    secureCookie: process.env.DASHBOARD_SECURE_COOKIE === 'true',
  },
});

const port = Number(process.env.PORT || 3000);
const server = app.listen(port, '0.0.0.0', () => console.log(`Dashboard disponível na porta ${port}`));

async function shutdown() {
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
