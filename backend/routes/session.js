const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');

/**
 * GET /api/sessions
 * List all active sessions.
 */
router.get('/', (_req, res) => {
  const sessionManager = require('../services/sessionManager');
  const sessions = sessionManager.listAll();
  res.json({ sessions });
});

/**
 * GET /api/session/:id
 * Get details for a single session.
 */
router.get('/:id', (req, res) => {
  const sessionManager = require('../services/sessionManager');
  const session = sessionManager.get(req.params.id);
  if (!session) {
    return res.status(404).json({ error: { message: 'Session not found', code: 'NOT_FOUND' } });
  }
  res.json({ session });
});

/**
 * DELETE /api/session/:id
 * Stop and cleanup a session (container + clone).
 */
router.delete('/:id', async (req, res, next) => {
  try {
    const sessionManager = require('../services/sessionManager');
    const sandboxOrchestrator = require('../services/sandboxOrchestrator');

    const session = sessionManager.get(req.params.id);
    if (!session) {
      return res.status(404).json({ error: { message: 'Session not found', code: 'NOT_FOUND' } });
    }

    // Stop & remove container
    if (session.containerId) {
      await sandboxOrchestrator.stopContainer(session.containerId);
    }

    sessionManager.remove(req.params.id);
    logger.info('Session stopped', { sessionId: req.params.id });

    res.json({ status: 'stopped', sessionId: req.params.id });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
