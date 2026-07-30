const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const { runLimiter } = require('../middleware/rateLimiter');

// ── In-flight SSE connections keyed by sessionId ──
const sseClients = new Map();

/**
 * Helper: parse owner/repo from a GitHub URL.
 */
function parseGitHubUrl(url) {
  const patterns = [
    /github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/|$)/,
    /^([^/]+)\/([^/]+)$/,
  ];
  for (const re of patterns) {
    const m = url.match(re);
    if (m) return { owner: m[1], repo: m[2].replace(/\.git$/, '') };
  }
  return null;
}

/**
 * POST /api/repo/analyze
 * Quick analysis — clones the repo, runs detection, returns stack info.
 */
router.post('/analyze', async (req, res, next) => {
  try {
    const { repoUrl } = req.body;
    if (!repoUrl) {
      return res.status(400).json({ error: { message: 'repoUrl is required', code: 'MISSING_PARAM' } });
    }

    const parsed = parseGitHubUrl(repoUrl);
    if (!parsed) {
      return res.status(400).json({ error: { message: 'Invalid GitHub URL', code: 'INVALID_URL' } });
    }

    const repoFetcher = require('../services/repoFetcher');
    const detectionEngine = require('../services/detectionEngine');
    const secretScanner = require('../utils/secretScanner');

    logger.info('Analyzing repo', { owner: parsed.owner, repo: parsed.repo });

    // 1. Shallow clone
    const clonePath = await repoFetcher.cloneRepo(parsed.owner, parsed.repo);

    // 2. Detect stack
    const detection = await detectionEngine.detect(clonePath, parsed);

    // 3. Scan for required secrets
    const secrets = await secretScanner.scan(clonePath, detection);

    // 4. Cleanup clone
    await repoFetcher.cleanup(clonePath);

    res.json({
      owner: parsed.owner,
      repo: parsed.repo,
      detection,
      requiredSecrets: secrets,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/repo/run
 * Full pipeline: clone → detect → generate config → build → run.
 * Returns a sessionId immediately; progress is streamed via SSE.
 */
router.post('/run', runLimiter, async (req, res, next) => {
  try {
    const { repoUrl, overrides } = req.body;
    if (!repoUrl) {
      return res.status(400).json({ error: { message: 'repoUrl is required', code: 'MISSING_PARAM' } });
    }

    const parsed = parseGitHubUrl(repoUrl);
    if (!parsed) {
      return res.status(400).json({ error: { message: 'Invalid GitHub URL', code: 'INVALID_URL' } });
    }

    // Fail before creating a session or cloning when Docker cannot run builds.
    const sandboxOrchestrator = require('../services/sandboxOrchestrator');
    const dockerStatus = await sandboxOrchestrator.checkDocker();
    if (!dockerStatus.available) {
      const err = new Error(`Docker Desktop is unavailable: ${dockerStatus.error}. Start Docker Desktop and ensure this account can access the Docker engine.`);
      err.status = 503;
      err.code = 'DOCKER_UNAVAILABLE';
      err.expose = true;
      throw err;
    }

    const sessionManager = require('../services/sessionManager');
    const session = sessionManager.create(parsed.owner, parsed.repo);

    // Return sessionId immediately; the pipeline runs asynchronously.
    res.json({ sessionId: session.id, status: 'started' });

    // Kick off the async pipeline
    runPipeline(session, parsed, overrides).catch(err => {
      logger.error('Pipeline failed', { sessionId: session.id, error: err.message });
      sessionManager.updateStatus(session.id, 'error', { error: err.message });
      emitSSE(session.id, { type: 'error', message: err.message });
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/repo/status/:sessionId
 * SSE endpoint — streams real-time progress for a running pipeline.
 */
router.get('/status/:sessionId', (req, res) => {
  const { sessionId } = req.params;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`data: ${JSON.stringify({ type: 'connected', sessionId })}\n\n`);

  // Register this SSE client
  if (!sseClients.has(sessionId)) sseClients.set(sessionId, new Set());
  sseClients.get(sessionId).add(res);

  // Send current session status immediately
  const sessionManager = require('../services/sessionManager');
  const session = sessionManager.get(sessionId);
  if (session) {
    res.write(`data: ${JSON.stringify({ type: 'status', ...session })}\n\n`);
    // If the session is already ready, immediately send the ready event
    if (session.status === 'ready' && session.previewUrl) {
      res.write(`data: ${JSON.stringify({
        type: 'step', step: 'run', status: 'done',
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        type: 'ready',
        previewUrl: session.previewUrl,
        terminalUrl: session.terminalUrl,
        ports: session.ports,
      })}\n\n`);
    }
  }

  req.on('close', () => {
    const clients = sseClients.get(sessionId);
    if (clients) {
      clients.delete(res);
      if (clients.size === 0) sseClients.delete(sessionId);
    }
  });
});

/**
 * Emit an SSE event to all listeners for a session.
 */
function emitSSE(sessionId, data) {
  const clients = sseClients.get(sessionId);
  if (!clients) return;
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    client.write(payload);
  }
}

/**
 * The main async pipeline: clone → detect → generate → build → run.
 */
async function runPipeline(session, parsed, overrides = {}) {
  const repoFetcher = require('../services/repoFetcher');
  const detectionEngine = require('../services/detectionEngine');
  const configGenerator = require('../services/configGenerator');
  const sandboxOrchestrator = require('../services/sandboxOrchestrator');
  const resolutionEngine = require('../services/resolutionEngine');
  const secretScanner = require('../utils/secretScanner');
  const sessionManager = require('../services/sessionManager');
  const cacheManager = require('../services/cacheManager');

  const repoKey = `${parsed.owner}/${parsed.repo}`;
  const cached = cacheManager.get(repoKey);

  // ── Step 1: Clone ──
  emitSSE(session.id, { type: 'step', step: 'clone', status: 'running', message: 'Cloning repository…' });
  sessionManager.updateStatus(session.id, 'cloning');
  const clonePath = await repoFetcher.cloneRepo(parsed.owner, parsed.repo);
  sessionManager.updateStatus(session.id, 'cloning', { clonePath });
  emitSSE(session.id, { type: 'step', step: 'clone', status: 'done' });

  // ── Step 2: Detect ──
  emitSSE(session.id, { type: 'step', step: 'detect', status: 'running', message: 'Detecting tech stack…' });
  sessionManager.updateStatus(session.id, 'detecting');
  let detection = await detectionEngine.detect(clonePath, parsed);

  // Apply cached overrides (community-trained resolutions)
  if (cached) {
    detection = { ...detection, ...cached.detection };
    emitSSE(session.id, { type: 'cache_hit', cached });
  }

  // Apply user overrides
  if (overrides.startCommand) detection.startCommand = overrides.startCommand;
  if (overrides.language) detection.language = overrides.language;

  emitSSE(session.id, { type: 'step', step: 'detect', status: 'done', detection });

  // ── Step 2b: Scan for secrets ──
  const secrets = await secretScanner.scan(clonePath, detection);
  if (secrets.length > 0 && !overrides.envVars) {
    // Check for resolution pause
    const resolved = resolutionEngine.checkSecrets(session.id, secrets, overrides);
    if (resolved.pending.length > 0) {
      sessionManager.updateStatus(session.id, 'waiting_for_input', {
        pendingResolutions: resolved.pending,
      });
      emitSSE(session.id, {
        type: 'resolution_needed',
        resolutions: resolved.pending,
      });
      // Pipeline pauses here — will be resumed when the user submits resolutions
      sessionManager.setPipelineResume(session.id, {
        clonePath, detection, secrets, parsed,
      });
      return;
    }
  }

  // ── Step 2c: Monorepo package selection ──
  if (detection.monorepoPackages && detection.monorepoPackages.length > 1 && !overrides.selectedPackage) {
    resolutionEngine.createPackagePicker(session.id, detection.monorepoPackages);
    const pending = resolutionEngine.getPending(session.id);
    sessionManager.updateStatus(session.id, 'waiting_for_input', { pendingResolutions: pending });
    emitSSE(session.id, { type: 'resolution_needed', resolutions: pending });
    sessionManager.setPipelineResume(session.id, { clonePath, detection, secrets, parsed });
    return;
  }

  // ── Step 2d: Ambiguous entrypoint ──
  if (!detection.startCommand && detection.confidence === 'low' && !overrides.startCommand) {
    resolutionEngine.createEntrypointPrompt(session.id, detection.detectedFiles);
    const pending = resolutionEngine.getPending(session.id);
    sessionManager.updateStatus(session.id, 'waiting_for_input', { pendingResolutions: pending });
    emitSSE(session.id, { type: 'resolution_needed', resolutions: pending });
    sessionManager.setPipelineResume(session.id, { clonePath, detection, secrets, parsed });
    return;
  }

  // ── Step 2e: GPU requirement notice ──
  if (detection.requiresGpu && !overrides.gpuAcknowledged) {
    resolutionEngine.createGpuNotice(session.id);
    const pending = resolutionEngine.getPending(session.id);
    sessionManager.updateStatus(session.id, 'waiting_for_input', { pendingResolutions: pending });
    emitSSE(session.id, { type: 'resolution_needed', resolutions: pending });
    sessionManager.setPipelineResume(session.id, { clonePath, detection, secrets, parsed });
    return;
  }

  // ── Step 3: Generate config ──
  await continueFromConfig(session.id, clonePath, detection, overrides, parsed);
}

/**
 * Resume a paused pipeline without skipping any later resolution gates. A
 * secret prompt can be followed by a package/start-command/GPU prompt.
 */
async function continueAfterResolution(sessionId, clonePath, detection, overrides, parsed) {
  const resolutionEngine = require('../services/resolutionEngine');
  const sessionManager = require('../services/sessionManager');

  if (detection.monorepoPackages && detection.monorepoPackages.length > 1 && !overrides.selectedPackage) {
    resolutionEngine.createPackagePicker(sessionId, detection.monorepoPackages);
    const pending = resolutionEngine.getPending(sessionId);
    sessionManager.updateStatus(sessionId, 'waiting_for_input', { pendingResolutions: pending });
    emitSSE(sessionId, { type: 'resolution_needed', resolutions: pending });
    sessionManager.setPipelineResume(sessionId, { clonePath, detection, parsed });
    return;
  }

  if (!detection.startCommand && detection.confidence === 'low' && !overrides.startCommand) {
    resolutionEngine.createEntrypointPrompt(sessionId, detection.detectedFiles);
    const pending = resolutionEngine.getPending(sessionId);
    sessionManager.updateStatus(sessionId, 'waiting_for_input', { pendingResolutions: pending });
    emitSSE(sessionId, { type: 'resolution_needed', resolutions: pending });
    sessionManager.setPipelineResume(sessionId, { clonePath, detection, parsed });
    return;
  }

  if (detection.requiresGpu && !overrides.gpuAcknowledged) {
    resolutionEngine.createGpuNotice(sessionId);
    const pending = resolutionEngine.getPending(sessionId);
    sessionManager.updateStatus(sessionId, 'waiting_for_input', { pendingResolutions: pending });
    emitSSE(sessionId, { type: 'resolution_needed', resolutions: pending });
    sessionManager.setPipelineResume(sessionId, { clonePath, detection, parsed });
    return;
  }

  await continueFromConfig(sessionId, clonePath, detection, overrides, parsed);
}

/**
 * Continue the pipeline from the config-generation step onward.
 * Called directly during normal flow, or after resolution input.
 */
async function continueFromConfig(sessionId, clonePath, detection, overrides, parsed) {
  const configGenerator = require('../services/configGenerator');
  const sandboxOrchestrator = require('../services/sandboxOrchestrator');
  const sessionManager = require('../services/sessionManager');
  const cacheManager = require('../services/cacheManager');

  emitSSE(sessionId, { type: 'step', step: 'config', status: 'running', message: 'Generating container config…' });
  sessionManager.updateStatus(sessionId, 'configuring');
  const containerConfig = configGenerator.generate(detection, overrides.envVars || {});
  emitSSE(sessionId, { type: 'step', step: 'config', status: 'done', config: containerConfig });

  let runResult;
  if (containerConfig.useExistingCompose) {
    // Docker Compose performs its own build and startup as one operation.
    emitSSE(sessionId, { type: 'step', step: 'build', status: 'running', message: 'Building Docker Compose services…' });
    sessionManager.updateStatus(sessionId, 'building');
    runResult = await sandboxOrchestrator.runCompose(sessionId, clonePath, (log) => {
      emitSSE(sessionId, { type: 'build_log', message: log });
    });
    emitSSE(sessionId, { type: 'step', step: 'build', status: 'done', imageId: 'docker-compose' });
  } else {
    // ── Step 4: Build ──
    emitSSE(sessionId, { type: 'step', step: 'build', status: 'running', message: 'Building container image…' });
    sessionManager.updateStatus(sessionId, 'building');
    const imageId = await sandboxOrchestrator.buildImage(sessionId, clonePath, containerConfig, (log) => {
      emitSSE(sessionId, { type: 'build_log', message: log });
    });
    emitSSE(sessionId, { type: 'step', step: 'build', status: 'done', imageId });

    logger.info('Pipeline: calling runContainer', { sessionId });
    runResult = await sandboxOrchestrator.runContainer(sessionId, imageId, containerConfig, (log) => {
      emitSSE(sessionId, { type: 'run_log', message: log });
    });
  }

  // ── Step 5: Run ──
  emitSSE(sessionId, { type: 'step', step: 'run', status: 'running', message: 'Starting application…' });
  sessionManager.updateStatus(sessionId, 'running');
  logger.info('Pipeline: runContainer returned', { sessionId, previewUrl: runResult.previewUrl });

  // Brief pause to let the container's app fully bind its port
  await new Promise(resolve => setTimeout(resolve, 1500));

  sessionManager.updateStatus(sessionId, 'ready', {
    previewUrl: runResult.previewUrl,
    terminalUrl: runResult.terminalUrl,
    containerId: runResult.containerId,
    ports: runResult.ports,
    serviceContainerIds: runResult.serviceContainerIds || [],
    networkName: runResult.networkName || null,
    composeProject: runResult.composeProject || null,
    composePath: runResult.composePath || null,
  });

  // Mark the run step as done so the extension spinner transitions to checkmark
  emitSSE(sessionId, { type: 'step', step: 'run', status: 'done' });
  logger.info('Pipeline: emitting ready event', { sessionId });

  emitSSE(sessionId, {
    type: 'ready',
    previewUrl: runResult.previewUrl,
    terminalUrl: runResult.terminalUrl,
    ports: runResult.ports,
  });

  // Cache successful detection for future runs
  const repoKey = `${parsed.owner}/${parsed.repo}`;
  cacheManager.set(repoKey, {
    detection,
    containerConfig,
    resolvedAt: new Date().toISOString(),
  });
}

// Expose for use by resolution route
router._continueFromConfig = continueFromConfig;
router._continueAfterResolution = continueAfterResolution;
router._emitSSE = emitSSE;

module.exports = router;
