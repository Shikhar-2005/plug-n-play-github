/**
 * Resolution Engine — interactive obstacle handling.
 *
 * Instead of treating a missing dependency as a failure, the resolution
 * engine creates structured prompts that the user can answer to
 * unblock the build. Each resolution is cached per-repo so future
 * users benefit.
 */

const logger = require('../utils/logger');
const { SERVICE_LINKS, SAFE_DEFAULTS } = require('../utils/secretScanner');

/** @type {Map<string, Object[]>} sessionId → pending resolutions */
const pendingResolutions = new Map();

/** @type {Map<string, Object>} sessionId → applied resolutions */
const appliedResolutions = new Map();

/**
 * Check which secrets need user input and build resolution prompts.
 *
 * @param {string} sessionId
 * @param {Array} secrets - From secretScanner.scan()
 * @param {Object} overrides - Any user-supplied overrides
 * @returns {{ resolved: Array, pending: Array }}
 */
function checkSecrets(sessionId, secrets, overrides = {}) {
  const resolved = [];
  const pending = [];

  const userEnvVars = overrides.envVars || {};

  for (const secret of secrets) {
    // Skip if auto-provisioned
    if (secret.autoProvision) {
      resolved.push({ name: secret.name, type: 'auto_provisioned' });
      continue;
    }

    // Skip if has a safe default
    if (secret.defaultValue || SAFE_DEFAULTS[secret.name.toUpperCase()]) {
      resolved.push({ name: secret.name, type: 'default', value: secret.defaultValue || SAFE_DEFAULTS[secret.name.toUpperCase()] });
      continue;
    }

    // Skip if user already provided
    if (userEnvVars[secret.name]) {
      resolved.push({ name: secret.name, type: 'user_provided' });
      continue;
    }

    // Skip non-required
    if (!secret.required) {
      resolved.push({ name: secret.name, type: 'optional' });
      continue;
    }

    // This needs user input
    const resolution = {
      id: `secret-${secret.name}`,
      type: 'missing_secret',
      name: secret.name,
      description: secret.description || `This repo requires ${secret.name} to run.`,
      service: secret.service || SERVICE_LINKS[secret.name.toUpperCase()] || null,
      inputType: 'text',
      placeholder: `Enter your ${secret.name}`,
      required: true,
    };

    pending.push(resolution);
  }

  // Store pending resolutions
  if (pending.length > 0) {
    pendingResolutions.set(sessionId, pending);
  }

  logger.info('Secret resolution check', {
    sessionId,
    resolved: resolved.length,
    pending: pending.length,
  });

  return { resolved, pending };
}

/**
 * Build a monorepo package selection resolution.
 */
function createPackagePicker(sessionId, packages) {
  const resolution = {
    id: 'monorepo-package',
    type: 'package_selection',
    description: 'This is a monorepo with multiple packages. Which one do you want to run?',
    inputType: 'select',
    options: packages.map(pkg => ({
      value: pkg,
      label: pkg,
    })),
    required: true,
  };

  const existing = pendingResolutions.get(sessionId) || [];
  existing.push(resolution);
  pendingResolutions.set(sessionId, existing);

  return resolution;
}

/**
 * Build an ambiguous entrypoint resolution.
 */
function createEntrypointPrompt(sessionId, detectedFiles = []) {
  const resolution = {
    id: 'start-command',
    type: 'ambiguous_entrypoint',
    description: 'We couldn\'t determine the start command for this repo. What command should be used to run it?',
    inputType: 'text',
    placeholder: 'e.g., npm run dev, python app.py, go run .',
    required: true,
    hint: detectedFiles.length > 0
      ? `Detected files: ${detectedFiles.join(', ')}`
      : null,
  };

  const existing = pendingResolutions.get(sessionId) || [];
  existing.push(resolution);
  pendingResolutions.set(sessionId, existing);

  return resolution;
}

/**
 * Build a GPU requirement notice.
 */
function createGpuNotice(sessionId) {
  const resolution = {
    id: 'gpu-notice',
    type: 'gpu_required',
    description: 'This repo appears to require GPU/CUDA support, which is not available in this sandbox tier.',
    inputType: 'confirm',
    options: [
      { value: 'cpu_fallback', label: 'Try running in CPU-only mode' },
      { value: 'cancel', label: 'Cancel — this repo needs a GPU' },
    ],
    required: true,
  };

  const existing = pendingResolutions.get(sessionId) || [];
  existing.push(resolution);
  pendingResolutions.set(sessionId, existing);

  return resolution;
}

/**
 * Apply user-submitted resolutions.
 */
function applyResolutions(sessionId, resolutions) {
  appliedResolutions.set(sessionId, resolutions);
  pendingResolutions.delete(sessionId);

  logger.info('Resolutions applied', {
    sessionId,
    keys: Object.keys(resolutions),
  });
}

/**
 * Get pending resolutions for a session.
 */
function getPending(sessionId) {
  return pendingResolutions.get(sessionId) || [];
}

/**
 * Get applied resolutions for a session.
 */
function getApplied(sessionId) {
  return appliedResolutions.get(sessionId) || {};
}

module.exports = {
  checkSecrets,
  createPackagePicker,
  createEntrypointPrompt,
  createGpuNotice,
  applyResolutions,
  getPending,
  getApplied,
};
