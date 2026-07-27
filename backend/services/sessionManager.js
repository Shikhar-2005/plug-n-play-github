/**
 * Session Manager — tracks all active sessions with metadata,
 * handles lifecycle, timeouts, and cleanup.
 */

const { v4: uuidv4 } = require('uuid');
const config = require('../config');
const logger = require('../utils/logger');

/** @type {Map<string, Object>} */
const sessions = new Map();

/** @type {Map<string, Object>} Pipeline resume data for paused sessions */
const pipelineResumeData = new Map();

/**
 * Create a new session.
 */
function create(owner, repo) {
  if (sessions.size >= config.maxSessions) {
    // Try to evict oldest idle session
    const evicted = evictOldest();
    if (!evicted) {
      const err = new Error(`Maximum sessions (${config.maxSessions}) reached`);
      err.status = 429;
      err.code = 'MAX_SESSIONS';
      err.expose = true;
      throw err;
    }
  }

  const session = {
    id: uuidv4(),
    owner,
    repo,
    repoKey: `${owner}/${repo}`,
    status: 'created',          // created | cloning | detecting | configuring | building | running | ready | waiting_for_input | error | stopped
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    containerId: null,
    previewUrl: null,
    terminalUrl: null,
    ports: null,
    error: null,
    pendingResolutions: [],
    detection: null,
  };

  sessions.set(session.id, session);
  logger.info('Session created', { sessionId: session.id, repo: session.repoKey });
  return session;
}

/**
 * Get a session by ID.
 */
function get(sessionId) {
  const session = sessions.get(sessionId);
  if (session) {
    session.lastActivityAt = new Date().toISOString();
  }
  return session || null;
}

/**
 * List all active sessions.
 */
function listAll() {
  return Array.from(sessions.values()).map(s => ({
    id: s.id,
    owner: s.owner,
    repo: s.repo,
    repoKey: s.repoKey,
    status: s.status,
    createdAt: s.createdAt,
    lastActivityAt: s.lastActivityAt,
    previewUrl: s.previewUrl,
    terminalUrl: s.terminalUrl,
    ports: s.ports,
    error: s.error,
  }));
}

/**
 * Update session status and merge additional data.
 */
function updateStatus(sessionId, status, data = {}) {
  const session = sessions.get(sessionId);
  if (!session) return;

  session.status = status;
  session.lastActivityAt = new Date().toISOString();
  Object.assign(session, data);

  logger.info('Session status updated', { sessionId, status });
}

/**
 * Remove a session.
 */
function remove(sessionId) {
  sessions.delete(sessionId);
  pipelineResumeData.delete(sessionId);
  logger.info('Session removed', { sessionId });
}

/**
 * Store pipeline resume data for a paused session (waiting for user input).
 */
function setPipelineResume(sessionId, data) {
  pipelineResumeData.set(sessionId, data);
}

/**
 * Get pipeline resume data.
 */
function getPipelineResume(sessionId) {
  return pipelineResumeData.get(sessionId) || null;
}

/**
 * Cleanup expired sessions (called periodically).
 */
function cleanupExpired() {
  const now = Date.now();
  const timeoutMs = config.sessionTimeoutMinutes * 60 * 1000;

  for (const [id, session] of sessions) {
    const lastActivity = new Date(session.lastActivityAt).getTime();
    const age = now - lastActivity;

    if (age > timeoutMs && session.status !== 'waiting_for_input') {
      logger.info('Session expired', { sessionId: id, ageMinutes: Math.round(age / 60000) });

      // Stop container if running
      if (session.containerId) {
        const sandboxOrchestrator = require('./sandboxOrchestrator');
        sandboxOrchestrator.stopContainer(session.containerId).catch(err => {
          logger.warn('Failed to stop expired container', { sessionId: id, error: err.message });
        });
      }

      remove(id);
    }
  }
}

/**
 * Evict the oldest idle session to make room for a new one.
 */
function evictOldest() {
  let oldest = null;
  let oldestTime = Infinity;

  for (const [id, session] of sessions) {
    const lastActivity = new Date(session.lastActivityAt).getTime();
    if (lastActivity < oldestTime && session.status !== 'building' && session.status !== 'cloning') {
      oldest = id;
      oldestTime = lastActivity;
    }
  }

  if (oldest) {
    const session = sessions.get(oldest);
    if (session && session.containerId) {
      const sandboxOrchestrator = require('./sandboxOrchestrator');
      sandboxOrchestrator.stopContainer(session.containerId).catch(() => {});
    }
    remove(oldest);
    logger.info('Evicted oldest session', { sessionId: oldest });
    return true;
  }

  return false;
}

module.exports = {
  create,
  get,
  listAll,
  updateStatus,
  remove,
  setPipelineResume,
  getPipelineResume,
  cleanupExpired,
};
