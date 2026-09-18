'use strict';

const express = require('express');

function safeContactRedirect(value) {
  return /^\d+$/.test(String(value || '')) ? `/contacts/${value}` : '/';
}

function salesRoutes(salesService) {
  const router = express.Router();

  router.post('/sales/:id/confirm', async (req, res, next) => {
    try {
      await salesService.confirmPayment({
        saleId: req.params.id,
        amount: req.body.amount,
        actor: req.session.user,
      });
      res.redirect(303, safeContactRedirect(req.body.contactId));
    } catch (error) {
      next(error);
    }
  });

  router.post('/sales/:id/unpaid', async (req, res, next) => {
    try {
      await salesService.markUnpaid({ saleId: req.params.id, actor: req.session.user });
      res.redirect(303, safeContactRedirect(req.body.contactId));
    } catch (error) {
      next(error);
    }
  });

  router.post('/contacts/:id/automation', async (req, res, next) => {
    try {
      await salesService.setAutomationState({
        contactId: req.params.id,
        state: req.body.state,
        actor: req.session.user,
      });
      res.redirect(303, `/contacts/${req.params.id}`);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { salesRoutes };
