'use strict';

const express = require('express');
const { STEP_ORDER, FOLLOWUP_ORDER, parseStoredSettings } = require('../domain/message-settings');

function dashboardRoutes(salesService) {
  const router = express.Router();

  router.get('/', async (req, res, next) => {
    try {
      const filters = { from: req.query.from, to: req.query.to, search: req.query.search };
      const data = await salesService.listSummary(filters);
      res.render('dashboard', { ...data, filters });
    } catch (error) {
      next(error);
    }
  });

  router.get('/messages', async (req, res, next) => {
    try {
      const rawSettings = await salesService.getMessageSettings();
      const settings = parseStoredSettings(JSON.stringify(rawSettings));
      res.render('messages', { settings, stepOrder: STEP_ORDER, followupOrder: FOLLOWUP_ORDER, saved: req.query.saved === '1' });
    } catch (error) {
      next(error);
    }
  });

  router.get('/contacts/:id', async (req, res, next) => {
    try {
      const data = await salesService.getContact(req.params.id);
      if (!data) return res.status(404).send('Contato não encontrado');
      return res.render('contact', data);
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

module.exports = { dashboardRoutes };
