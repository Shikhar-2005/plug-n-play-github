require('dotenv').config();

const config = {
  // ── Server ──
  port: parseInt(process.env.PORT, 10) || 3000,
  host: process.env.HOST || '0.0.0.0',

  // ── Session ──
  sessionTimeoutMinutes: parseInt(process.env.SESSION_TIMEOUT_MINUTES, 10) || 30,
  maxSessions: parseInt(process.env.MAX_SESSIONS, 10) || 10,
  maxContainerMemory: process.env.MAX_CONTAINER_MEMORY || '512m',
  maxContainerCpu: parseFloat(process.env.MAX_CONTAINER_CPU) || 1.0,

  // ── Docker ──
  dockerSocket: process.env.DOCKER_SOCKET || (process.platform === 'win32'
    ? '//./pipe/docker_engine'
    : '/var/run/docker.sock'),

  // ── Rate limiting ──
  rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 15 * 60 * 1000,
  rateLimitMaxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS, 10) || 100,

  // ── Repo limits ──
  maxRepoSizeMB: parseInt(process.env.MAX_REPO_SIZE_MB, 10) || 500,
  cloneTimeoutMs: parseInt(process.env.CLONE_TIMEOUT_MS, 10) || 60000,

  // ── GitHub ──
  githubToken: process.env.GITHUB_TOKEN || null,

  // ── Paths ──
  cloneDir: process.env.CLONE_DIR || (process.platform === 'win32'
    ? 'C:\\temp\\reporun-clones'
    : '/tmp/reporun-clones'),
  cacheDir: process.env.CACHE_DIR || (process.platform === 'win32'
    ? 'C:\\temp\\reporun-cache'
    : '/tmp/reporun-cache'),

  // ── Port range for exposed containers ──
  portRangeStart: parseInt(process.env.PORT_RANGE_START, 10) || 10000,
  portRangeEnd: parseInt(process.env.PORT_RANGE_END, 10) || 11000,
};

module.exports = config;
