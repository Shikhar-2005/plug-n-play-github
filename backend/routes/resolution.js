const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');

/**
 * GET /api/resolution/:sessionId
 * Get any pending resolution prompts for a session.
 */
router.get('/:sessionId', (req, res) => {
  const sessionManager = require('../services/sessionManager');
  const session = sessionManager.get(req.params.sessionId);
  if (!session) {
    return res.status(404).json({ error: { message: 'Session not found', code: 'NOT_FOUND' } });
  }

  res.json({
    sessionId: req.params.sessionId,
    status: session.status,
    pendingResolutions: session.pendingResolutions || [],
  });
});

/**
 * POST /api/resolution/:sessionId
 * Submit a resolution (API key, package choice, start command, etc.)
 * and resume the pipeline.
 */
router.post('/:sessionId', async (req, res, next) => {
  try {
    const sessionManager = require('../services/sessionManager');
    const resolutionEngine = require('../services/resolutionEngine');
    const repoRoute = require('./repo');

    const session = sessionManager.get(req.params.sessionId);
    if (!session) {
      return res.status(404).json({ error: { message: 'Session not found', code: 'NOT_FOUND' } });
    }
    if (session.status !== 'waiting_for_input') {
      return res.status(400).json({ error: { message: 'Session is not waiting for input', code: 'INVALID_STATE' } });
    }

    const { resolutions } = req.body;
    // resolutions = { envVars: { KEY: 'value' }, startCommand: '…', selectedPackage: '…' }

    if (!resolutions) {
      return res.status(400).json({ error: { message: 'resolutions object is required', code: 'MISSING_PARAM' } });
    }

    logger.info('Resolution submitted', { sessionId: req.params.sessionId, keys: Object.keys(resolutions) });

    // Store resolutions & clear pending
    resolutionEngine.applyResolutions(req.params.sessionId, resolutions);
    sessionManager.updateStatus(req.params.sessionId, 'resuming', { pendingResolutions: [] });

    res.json({ status: 'resuming', sessionId: req.params.sessionId });

    // Resume the pipeline
    const resumeData = sessionManager.getPipelineResume(req.params.sessionId);
    if (resumeData) {
      const overrides = { envVars: resolutions.envVars || {}, ...resolutions };
      repoRoute._continueFromConfig(
        req.params.sessionId,
        resumeData.clonePath,
        { ...resumeData.detection, ...(resolutions.startCommand && { startCommand: resolutions.startCommand }) },
        overrides,
        resumeData.parsed,
      ).catch(err => {
        logger.error('Resume pipeline failed', { sessionId: req.params.sessionId, error: err.message });
        sessionManager.updateStatus(req.params.sessionId, 'error', { error: err.message });
        repoRoute._emitSSE(req.params.sessionId, { type: 'error', message: err.message });
      });
    }
  } catch (err) {
    next(err);
  }
});

module.exports = router;
