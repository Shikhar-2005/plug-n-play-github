const express = require('express');
const fs = require('fs');
const path = require('path');
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

    const resumeData = sessionManager.getPipelineResume(req.params.sessionId);
    const pending = resolutionEngine.getPending(req.params.sessionId);
    let clonePath = resumeData && resumeData.clonePath;
    let detection = resumeData && resumeData.detection;

    // A package picker must switch the Docker build context and rerun stack
    // detection for the chosen application, not merely dismiss the prompt.
    const packagePromptPending = pending.some(resolution => resolution.type === 'package_selection');
    if (resumeData && packagePromptPending && resumeData.detection.monorepoPackages && resumeData.detection.monorepoPackages.length > 1) {
      const selectedPackage = resolutions.selectedPackage;
      if (!selectedPackage || !resumeData.detection.monorepoPackages.includes(selectedPackage)) {
        return res.status(400).json({ error: { message: 'Choose one of the detected monorepo packages.', code: 'INVALID_PACKAGE_SELECTION' } });
      }

      const rootPath = path.resolve(resumeData.clonePath);
      const selectedPath = path.resolve(rootPath, selectedPackage);
      if (!selectedPath.startsWith(`${rootPath}${path.sep}`) || !fs.existsSync(selectedPath)) {
        return res.status(400).json({ error: { message: 'Selected package is outside the cloned repository or no longer exists.', code: 'INVALID_PACKAGE_SELECTION' } });
      }

      const detectionEngine = require('../services/detectionEngine');
      const selectedDetection = await detectionEngine.detect(selectedPath, resumeData.parsed);
      // Build from the workspace root so root lockfiles and shared packages are
      // available, while the generated image starts in the selected package.
      clonePath = resumeData.clonePath;
      detection = {
        ...selectedDetection,
        packageManager: resumeData.detection.packageManager || selectedDetection.packageManager,
        workspacePackage: selectedPackage,
      };
    }

    logger.info('Resolution submitted', { sessionId: req.params.sessionId, keys: Object.keys(resolutions) });

    // Store resolutions & clear pending
    resolutionEngine.applyResolutions(req.params.sessionId, resolutions);
    sessionManager.updateStatus(req.params.sessionId, 'resuming', { pendingResolutions: [] });

    res.json({ status: 'resuming', sessionId: req.params.sessionId });

    // Handle GPU cancel — user chose not to continue
    if (resolutions.gpuChoice === 'cancel') {
      sessionManager.updateStatus(req.params.sessionId, 'stopped', { error: 'GPU required — cancelled by user' });
      repoRoute._emitSSE(req.params.sessionId, { type: 'error', message: 'This repo requires GPU support which is not available. Session cancelled.' });
      return;
    }

    // Resume the pipeline, including any prompts that follow this one.
    if (resumeData) {
      const overrides = {
        envVars: resolutions.envVars || {},
        ...resolutions,
        // Mark GPU as acknowledged so pipeline doesn't re-prompt
        gpuAcknowledged: resolutions.gpuChoice === 'cpu_fallback' || resolutions.gpuAcknowledged || undefined,
      };
      repoRoute._continueAfterResolution(
        req.params.sessionId,
        clonePath,
        { ...detection, ...(resolutions.startCommand && { startCommand: resolutions.startCommand }) },
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
