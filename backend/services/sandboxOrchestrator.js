/**
 * Sandbox Orchestrator — manages Docker container lifecycle.
 *
 * Uses the Docker Engine API (via dockerode) to:
 * - Build images from generated Dockerfiles
 * - Start containers with resource limits & security options
 * - Auto-provision ephemeral database/service containers
 * - Stream build/run logs
 * - Attach interactive terminal sessions (WebSocket)
 * - Cleanup containers on session expiry
 */

const Docker = require('dockerode');
const fs = require('fs');
const path = require('path');
const net = require('net');
const config = require('../config');
const logger = require('../utils/logger');

const docker = new Docker({
  socketPath: config.dockerSocket,
});

// Track allocated ports
const allocatedPorts = new Set();
let nextPort = config.portRangeStart;

/**
 * Check if a TCP port is free on the network interface.
 */
function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '0.0.0.0');
  });
}

/**
 * Query active Docker containers to ensure port is not bound in WSL2 proxy.
 */
async function isDockerPortFree(port) {
  try {
    const containers = await docker.listContainers({ all: true });
    for (const c of containers) {
      if (c.Ports && c.State === 'running') {
        for (const p of c.Ports) {
          if (p.PublicPort === port) return false;
        }
      }
    }
    return true;
  } catch (e) {
    return true;
  }
}

/**
 * Allocate an available host port verified against OS stack & Docker containers.
 */
async function allocatePort() {
  const start = config.portRangeStart;
  const end = config.portRangeEnd;

  for (let attempts = 0; attempts <= (end - start); attempts++) {
    const port = nextPort;
    nextPort = nextPort >= end ? start : nextPort + 1;

    if (!allocatedPorts.has(port) && (await isPortFree(port)) && (await isDockerPortFree(port))) {
      allocatedPorts.add(port);
      return port;
    }
  }
  throw new Error('No available ports in the configured range');
}

function releasePort(port) {
  allocatedPorts.delete(port);
}

/**
 * Build a Docker image for a session.
 *
 * @param {string} sessionId - Session identifier
 * @param {string} clonePath - Path to cloned repo
 * @param {Object} containerConfig - Config generator output
 * @param {Function} onLog - Callback for build log lines
 * @returns {string} The built image ID/tag
 */
async function buildImage(sessionId, clonePath, containerConfig, onLog = () => {}) {
  const tag = `reporun-${sessionId}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');

  if (containerConfig.useExistingCompose) {
    // For docker-compose repos, we'll use docker-compose up directly
    onLog('Using existing docker-compose configuration');
    return tag;
  }

  // Write Dockerfile if generated
  const dockerfilePath = path.join(clonePath, 'Dockerfile');
  if (containerConfig.dockerfile && !containerConfig.useExistingDockerfile) {
    fs.writeFileSync(dockerfilePath, containerConfig.dockerfile, 'utf-8');
    onLog('Generated Dockerfile written');
  }

  if (!fs.existsSync(dockerfilePath)) {
    throw new Error('No Dockerfile found or generated — cannot build image');
  }

  onLog('Starting Docker build…');
  logger.info('Building Docker image', { sessionId, tag, path: clonePath });

  // Create a tar stream of the build context
  const tar = require('tar-fs');
  const buildContext = tar.pack(clonePath);

  const stream = await docker.buildImage(buildContext, {
    t: tag,
    dockerfile: 'Dockerfile',
    rm: true,      // Remove intermediate containers
    forcerm: true,  // Remove on error too
  });

  // Stream build output
  await new Promise((resolve, reject) => {
    docker.modem.followProgress(stream, (err, output) => {
      if (err) {
        onLog(`Build error: ${err.message}`);
        reject(err);
      } else {
        resolve(output);
      }
    }, (event) => {
      if (event.stream) {
        const line = event.stream.replace(/\n$/, '');
        if (line) onLog(line);
      }
      if (event.error) {
        onLog(`Error: ${event.error}`);
      }
    });
  });

  onLog('Build complete ✓');
  logger.info('Docker image built', { sessionId, tag });
  return tag;
}

/**
 * Run a container from a built image.
 *
 * @param {string} sessionId
 * @param {string} imageTag
 * @param {Object} containerConfig
 * @param {Function} onLog - Callback for run log lines
 * @returns {{ containerId, previewUrl, terminalUrl, ports }}
 */
async function runContainer(sessionId, imageTag, containerConfig, onLog = () => {}) {
  const containerPort = containerConfig.exposePort || 3000;
  const memoryBytes = parseMemoryLimit(config.maxContainerMemory);

  const envArray = Object.entries(containerConfig.envVars || {}).map(([k, v]) => `${k}=${v}`);
  envArray.push(`PORT=${containerPort}`);

  let hostPort;
  let container;

  for (let retry = 0; retry < 10; retry++) {
    hostPort = await allocatePort();
    const containerName = `reporun-${sessionId}-${retry > 0 ? retry : ''}`.replace(/-+$/, '').toLowerCase().replace(/[^a-z0-9-]/g, '-');

    onLog(`Starting container on port ${hostPort} → ${containerPort}…`);
    logger.info('Starting container attempt', { sessionId, containerName, hostPort, containerPort, retry });

    try {
      container = await docker.createContainer({
        name: containerName,
        Image: imageTag,
        Env: envArray,
        ExposedPorts: {
          [`${containerPort}/tcp`]: {},
        },
        HostConfig: {
          PortBindings: {
            [`${containerPort}/tcp`]: [{ HostPort: String(hostPort) }],
          },
          Memory: memoryBytes,
          NanoCpus: config.maxContainerCpu * 1e9,
          SecurityOpt: ['no-new-privileges'],
          CapDrop: ['ALL'],
          CapAdd: ['CHOWN', 'SETGID', 'SETUID', 'NET_BIND_SERVICE'],
        },
        AttachStdout: true,
        AttachStderr: true,
      });

      await container.start();
      break;
    } catch (err) {
      if (err.message && (err.message.includes('already allocated') || err.message.includes('bind') || err.message.includes('address already in use'))) {
        logger.warn(`Port ${hostPort} collision during Docker bind, retrying with next port…`, { error: err.message });
        if (container) await container.remove({ force: true }).catch(() => {});
        releasePort(hostPort);
        if (retry === 9) throw err;
      } else {
        throw err;
      }
    }
  }

  onLog('Container started ✓');

  // Stream logs
  const logStream = await container.logs({
    follow: true,
    stdout: true,
    stderr: true,
    tail: 50,
  });

  logStream.on('data', (chunk) => {
    // Docker log stream has an 8-byte header per frame
    const line = chunk.toString('utf-8').replace(/^.{8}/, '').trim();
    if (line) onLog(line);
  });

  const previewUrl = `http://localhost:${hostPort}`;
  const terminalUrl = `ws://localhost:${config.port}/ws/terminal?sessionId=${sessionId}`;

  return {
    containerId: container.id,
    previewUrl,
    terminalUrl,
    ports: { host: hostPort, container: containerPort },
  };
}

/**
 * Attach a WebSocket to a container's exec for interactive terminal.
 */
async function attachTerminal(containerId, ws) {
  const container = docker.getContainer(containerId);

  const exec = await container.exec({
    Cmd: ['/bin/sh'],
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
  });

  const execStream = await exec.start({
    hijack: true,
    stdin: true,
    Tty: true,
  });

  // Pipe container output → WebSocket
  execStream.on('data', (data) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(data.toString('utf-8'));
    }
  });

  // Pipe WebSocket input → container
  ws.on('message', (data) => {
    execStream.write(data.toString());
  });

  ws.on('close', () => {
    execStream.end();
  });

  execStream.on('end', () => {
    if (ws.readyState === ws.OPEN) {
      ws.close();
    }
  });
}

/**
 * Stop and remove a container.
 */
async function stopContainer(containerId) {
  try {
    const container = docker.getContainer(containerId);
    const info = await container.inspect();

    if (info.State.Running) {
      await container.stop({ t: 5 }); // 5 second grace period
    }
    await container.remove({ force: true });

    // Release port
    const portBindings = info.HostConfig && info.HostConfig.PortBindings;
    if (portBindings) {
      for (const bindings of Object.values(portBindings)) {
        for (const binding of bindings) {
          if (binding.HostPort) releasePort(parseInt(binding.HostPort, 10));
        }
      }
    }

    // Try to remove the image too
    try {
      await docker.getImage(info.Config.Image).remove({ force: true });
    } catch {
      // Image might be shared, ignore
    }

    logger.info('Container stopped and removed', { containerId });
  } catch (err) {
    if (err.statusCode !== 404) {
      logger.warn('Failed to stop container', { containerId, error: err.message });
    }
  }
}

/**
 * Check if Docker is available and running.
 */
async function checkDocker() {
  try {
    const info = await docker.info();
    return {
      available: true,
      version: info.ServerVersion,
      containers: info.Containers,
    };
  } catch (err) {
    return {
      available: false,
      error: err.message,
    };
  }
}

/**
 * Parse memory limit string (e.g., "512m", "1g") to bytes.
 */
function parseMemoryLimit(limit) {
  const match = limit.match(/^(\d+)(m|g|k)?$/i);
  if (!match) return 512 * 1024 * 1024; // Default 512MB
  const value = parseInt(match[1], 10);
  const unit = (match[2] || 'm').toLowerCase();
  const multipliers = { k: 1024, m: 1024 * 1024, g: 1024 * 1024 * 1024 };
  return value * (multipliers[unit] || multipliers.m);
}

module.exports = {
  buildImage,
  runContainer,
  stopContainer,
  attachTerminal,
  checkDocker,
  allocatePort,
  releasePort,
};
