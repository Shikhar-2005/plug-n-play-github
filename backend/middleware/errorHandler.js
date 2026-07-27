const logger = require('../utils/logger');

/**
 * Centralised error handler — catches unhandled errors and returns a
 * consistent JSON error shape.
 */
function errorHandler(err, _req, res, _next) {
  const status = err.status || err.statusCode || 500;
  const message = err.expose ? err.message : 'Internal server error';

  logger.error(err.message, {
    stack: err.stack,
    status,
    code: err.code,
  });

  res.status(status).json({
    error: {
      message,
      code: err.code || 'INTERNAL_ERROR',
      ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
    },
  });
}

module.exports = errorHandler;
