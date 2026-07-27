/**
 * RepoRun — Backend API Server
 *
 * Express server with CORS, SSE progress streaming, WebSocket terminal proxy,
 * rate limiting, and all API routes for the repo analysis & run pipeline.
 */

const express = require('express');
const cors = require('cors');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');

const config = require('./config');
const logger = require('./utils/logger');
const { globalLimiter } = require('./middleware/rateLimiter');
const errorHandler = require('./middleware/errorHandler');

// ── Routes ──
const repoRoutes = require('./routes/repo');
const sessionRoutes = require('./routes/session');
const resolutionRoutes = require('./routes/resolution');

const app = express();
const server = http.createServer(app);

// ── Middleware ──
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (curl, server-to-server) or local file/iframe origins
    if (!origin || origin === 'null') return callback(null, true);
    // Allow Chrome extensions, GitHub web pages, localhost, and 127.0.0.1
    if (/^chrome-extension:\/\//.test(origin)
      || /^https?:\/\/([a-zA-Z0-9-]+\.)?github\.com/.test(origin)
      || /^http:\/\/localhost/.test(origin)
      || /^http:\/\/127\.0\.0\.1/.test(origin)) {
      return callback(null, true);
    }
    logger.warn('CORS blocked request', { origin });
    callback(new Error(`CORS not allowed for origin: ${origin}`));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Session-Id'],
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));
app.use(globalLimiter);

// ── Serve dashboard (static) ──
const dashboardPath = path.join(__dirname, '..', 'dashboard');
if (fs.existsSync(dashboardPath)) {
  app.use('/dashboard', express.static(dashboardPath));
}

// ── Health check ──
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    version: '1.0.0',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// ── API routes ──
app.use('/api/repo', repoRoutes);
app.use('/api/sessions', sessionRoutes);
app.use('/api/session', sessionRoutes);
app.use('/api/resolution', resolutionRoutes);

// ── Error handler (must be last) ──
app.use(errorHandler);

// ── WebSocket server for terminal proxy ──
const wss = new WebSocketServer({ server, path: '/ws/terminal' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const sessionId = url.searchParams.get('sessionId');

  if (!sessionId) {
    ws.close(4000, 'sessionId query param required');
    return;
  }

  logger.info('Terminal WebSocket connected', { sessionId });

  const sessionManager = require('./services/sessionManager');
  const sandboxOrchestrator = require('./services/sandboxOrchestrator');
  const session = sessionManager.get(sessionId);

  if (!session || !session.containerId) {
    ws.close(4001, 'Session not found or container not running');
    return;
  }

  // Attach to the container's exec for an interactive shell
  sandboxOrchestrator.attachTerminal(session.containerId, ws).catch(err => {
    logger.error('Terminal attach failed', { sessionId, error: err.message });
    ws.close(4002, 'Failed to attach terminal');
  });

  ws.on('close', () => {
    logger.info('Terminal WebSocket disconnected', { sessionId });
  });
});

// ── Ensure temp directories exist ──
[config.cloneDir, config.cacheDir].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// ── Start session cleanup interval ──
const sessionManager = require('./services/sessionManager');
setInterval(() => {
  sessionManager.cleanupExpired();
}, 60 * 1000); // Check every minute

// ── Start server ──
server.listen(config.port, config.host, () => {
  logger.info(`RepoRun server running`, {
    url: `http://${config.host}:${config.port}`,
    dashboard: `http://localhost:${config.port}/dashboard`,
    env: process.env.NODE_ENV || 'development',
  });
});

module.exports = { app, server };
