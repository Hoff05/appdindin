'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');
const { csrfProtection, requireAuth, verifyScrypt } = require('./auth');
const { dashboardRoutes } = require('./routes/dashboard');
const { salesRoutes } = require('./routes/sales');

function formatMoney(value) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(value || 0));
}

function formatDate(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo',
  }).format(new Date(value));
}

function createApp({ salesService, sessionStore, authConfig }) {
  if (!salesService) throw new Error('salesService é obrigatório');
  if (!authConfig?.username || !authConfig?.passwordHash || !authConfig?.sessionSecret) {
    throw new Error('Configuração de autenticação incompleta');
  }

  const app = express();
  app.disable('x-powered-by');
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.locals.formatMoney = formatMoney;
  app.locals.formatDate = formatDate;
  app.use(express.urlencoded({ extended: false, limit: '32kb' }));
  app.use('/static', express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
  app.use(session({
    name: 'zap.sid',
    secret: authConfig.sessionSecret,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: authConfig.secureCookie === true,
      maxAge: 8 * 60 * 60 * 1000,
    },
  }));
  app.use(csrfProtection);

  app.get('/health', (req, res) => res.json({ status: 'ok' }));
  app.get('/login', (req, res) => {
    if (req.session.user) return res.redirect('/');
    return res.render('login', { error: null });
  });
  app.post('/login', async (req, res, next) => {
    try {
      const validUser = crypto.timingSafeEqual(
        Buffer.from(String(req.body.username || '').padEnd(100).slice(0, 100)),
        Buffer.from(authConfig.username.padEnd(100).slice(0, 100)),
      );
      const validPassword = await verifyScrypt(req.body.password, authConfig.passwordHash);
      if (!validUser || !validPassword) return res.status(401).render('login', { error: 'Usuário ou senha inválidos.' });

      return req.session.regenerate((error) => {
        if (error) return next(error);
        req.session.user = authConfig.username;
        req.session.csrfToken = crypto.randomBytes(24).toString('base64url');
        return res.redirect(303, '/');
      });
    } catch (error) {
      return next(error);
    }
  });
  app.post('/logout', requireAuth, (req, res, next) => {
    req.session.destroy((error) => error ? next(error) : res.redirect(303, '/login'));
  });

  app.use(requireAuth);
  app.use(dashboardRoutes(salesService));
  app.use(salesRoutes(salesService));

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = /inválid|não encontrad|não pode/i.test(error.message) ? 400 : 500;
    return res.status(status).send(status === 500 ? 'Erro interno.' : error.message);
  });
  return app;
}

module.exports = { createApp };
