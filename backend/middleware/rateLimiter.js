const rateLimit = require('express-rate-limit');
const config = require('../config');

/**
 * Global rate limiter — caps requests per IP within a sliding window.
 */
const globalLimiter = rateLimit({
  windowMs: config.rateLimitWindowMs,
  max: config.rateLimitMaxRequests,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many requests — please try again later.',
    retryAfterSeconds: Math.ceil(config.rateLimitWindowMs / 1000),
  },
});

/**
 * Stricter limiter for repo-run endpoints (expensive operations).
 */
const runLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 10,                   // 10 runs per 5 min per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Run limit reached — please wait before starting another session.',
  },
});

module.exports = { globalLimiter, runLimiter };
