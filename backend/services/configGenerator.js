/**
 * Config Generator — takes detection engine output and produces
 * a Dockerfile and/or docker-compose.yml configuration.
 */

const { templates, serviceCompose, serviceEnvVars } = require('../utils/dockerTemplates');
const logger = require('../utils/logger');

/**
 * Generate container configuration from detection results.
 *
 * @param {Object} detection - Detection engine result
 * @param {Object} userEnvVars - User-supplied env vars (from resolution)
 * @returns {{ dockerfile: string, envVars: Object, services: Object, exposePort: number, startCommand: string }}
 */
function generate(detection, userEnvVars = {}) {
  const config = {
    dockerfile: null,
    envVars: {},
    services: {},
    exposePort: 3000,
    startCommand: detection.startCommand,
    useExistingDockerfile: false,
    existingDockerfilePath: null,
    useExistingCompose: false,
  };

  // ── Use existing devcontainer/docker-compose/Dockerfile ──
  if (detection.language === 'devcontainer') {
    const devcontainer = detection.raw && detection.raw.devcontainer;
    const dockerfilePath = devcontainer && (devcontainer.dockerFile || (devcontainer.build && devcontainer.build.dockerfile));
    if (!dockerfilePath) {
      const err = new Error('Dev Container detected, but it does not declare a Dockerfile that RepoRun can build. Add a Dockerfile or a runnable application manifest.');
      err.code = 'UNSUPPORTED_DEVCONTAINER';
      err.expose = true;
      throw err;
    }
    config.useExistingDockerfile = true;
    config.existingDockerfilePath = dockerfilePath;
    logger.info('Using Dockerfile declared by devcontainer', { dockerfilePath });
  }

  // Prefer a repository-owned Compose definition whenever present. It is the
  // only reliable source for that project's service topology and port mapping.
  if (detection.hasDockerCompose || detection.language === 'docker-compose') {
    config.useExistingCompose = true;
    logger.info('Using existing docker-compose config');
  }

  if (detection.hasDockerfile && !config.useExistingCompose && !config.useExistingDockerfile) {
    config.useExistingDockerfile = true;
    config.existingDockerfilePath = 'Dockerfile';
    logger.info('Using existing Dockerfile');
  }

  // ── Generate Dockerfile from template ──
  if (!config.useExistingDockerfile && !config.useExistingCompose) {
    const templateKey = getTemplateKey(detection);
    const templateFn = templates[templateKey];

    if (templateFn) {
      config.dockerfile = templateFn(detection);
      logger.info('Generated Dockerfile', { template: templateKey });
    } else {
      // Fallback: generic Dockerfile
      config.dockerfile = generateFallbackDockerfile(detection);
      logger.warn('Using fallback Dockerfile template', { language: detection.language });
    }
  }

  // ── Determine the primary port to expose ──
  config.exposePort = getDefaultPort(detection);

  // ── Auto-provision services ──
  if (detection.services && detection.services.length > 0) {
    config.services = serviceCompose(detection.services);
    const autoEnvVars = serviceEnvVars(detection.services);
    config.envVars = { ...autoEnvVars, ...config.envVars };
    logger.info('Auto-provisioning services', { services: detection.services });
  }

  // ── Merge user-supplied env vars ──
  config.envVars = { ...config.envVars, ...userEnvVars };

  // ── Add safe defaults ──
  if (detection.language === 'node') {
    config.envVars.NODE_ENV = config.envVars.NODE_ENV || 'development';
    config.envVars.HOST = config.envVars.HOST || '0.0.0.0';
  } else if (detection.language === 'python') {
    config.envVars.PYTHONDONTWRITEBYTECODE = '1';
    config.envVars.PYTHONUNBUFFERED = '1';
  }

  return config;
}

/**
 * Map detection language/framework to a template key.
 */
function getTemplateKey(detection) {
  switch (detection.language) {
    case 'node': return 'node';
    case 'python': return 'python';
    case 'go': return 'go';
    case 'rust': return 'rust';
    case 'java':
      return detection.packageManager === 'gradle' ? 'java_gradle' : 'java_maven';
    case 'ruby': return 'ruby';
    case 'php': return 'php';
    case 'html':
    case 'static': return 'html';
    default: return null;
  }
}

/**
 * Get the default port for a detected stack.
 */
function getDefaultPort(detection) {
  const frameworkPorts = {
    nextjs: 3000,
    vite: 5173,
    nuxt: 3000,
    'create-react-app': 3000,
    react: 5173,
    vue: 5173,
    svelte: 5173,
    sveltekit: 5173,
    angular: 4200,
    express: 3000,
    fastify: 3000,
    koa: 3000,
    nestjs: 3000,
    hono: 3000,
    django: 8000,
    flask: 5000,
    fastapi: 8000,
    streamlit: 8501,
    gin: 8080,
    fiber: 8080,
    echo: 8080,
    gorilla: 8080,
  };

  if (detection.framework && frameworkPorts[detection.framework]) {
    return frameworkPorts[detection.framework];
  }

  const languagePorts = {
    node: 3000,
    python: 8000,
    go: 8080,
    rust: 8080,
    java: 8080,
    ruby: 3000,
    php: 8000,
    html: 80,
    static: 80,
  };

  return languagePorts[detection.language] || 3000;
}

/**
 * Generate a generic fallback Dockerfile for unknown stacks.
 */
function generateFallbackDockerfile(detection) {
  const startCmd = detection.startCommand || 'python3 -m http.server 3000';
  return `FROM python:3.12-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \\
    curl git make bash && \\
    rm -rf /var/lib/apt/lists/*

COPY . .

EXPOSE 3000 8000 8080

CMD ${shellCommand(startCmd)}
`;
}

function shellCommand(command) {
  return JSON.stringify(['/bin/sh', '-c', command]);
}

module.exports = { generate };
