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
const { spawn } = require('child_process');
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
    throw new Error('Compose projects must be started with runCompose().');
  }

  // Write Dockerfile if generated
  const dockerfileName = containerConfig.existingDockerfilePath || 'Dockerfile';
  const dockerfilePath = path.join(clonePath, dockerfileName);
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
    dockerfile: dockerfileName.replace(/\\/g, '/'),
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

function resourceName(prefix, sessionId) {
  return `${prefix}-${sessionId.slice(0, 12)}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

async function pullImage(image, onLog) {
  try {
    await docker.getImage(image).inspect();
    return;
  } catch (err) {
    if (err.statusCode && err.statusCode !== 404) throw err;
  }

  onLog(`Pulling service image ${image}…`);
  const stream = await docker.pull(image);
  await new Promise((resolve, reject) => {
    docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve()));
  });
}

function tmpfsConfig(paths = []) {
  return Object.fromEntries(paths.map(tmpfsPath => [tmpfsPath, 'rw,nosuid,nodev,size=128m']));
}

async function provisionServices(sessionId, services, onLog) {
  const serviceEntries = Object.entries(services || {});
  if (serviceEntries.length === 0) return { networkName: null, serviceContainerIds: [] };

  const networkName = resourceName('reporun-net', sessionId);
  const network = await docker.createNetwork({
    Name: networkName,
    Driver: 'bridge',
    Labels: { 'com.reporun.session': sessionId },
  });
  const serviceContainerIds = [];

  try {
    for (const [serviceName, service] of serviceEntries) {
      await pullImage(service.image, onLog);
      const serviceContainer = await docker.createContainer({
        name: resourceName(`reporun-${serviceName}`, sessionId),
        Image: service.image,
        Env: Object.entries(service.environment || {}).map(([key, value]) => `${key}=${value}`),
        Labels: { 'com.reporun.session': sessionId, 'com.reporun.service': serviceName },
        HostConfig: {
          NetworkMode: networkName,
          Tmpfs: tmpfsConfig(service.tmpfs),
        },
        NetworkingConfig: {
          EndpointsConfig: {
            [networkName]: { Aliases: [serviceName] },
          },
        },
      });
      await serviceContainer.start();
      serviceContainerIds.push(serviceContainer.id);
      onLog(`Started ${serviceName} service`);
    }
  } catch (err) {
    await cleanupServices(serviceContainerIds, networkName);
    throw err;
  }

  return { networkName, serviceContainerIds };
}

async function cleanupServices(serviceContainerIds = [], networkName = null) {
  await Promise.all(serviceContainerIds.map(async (containerId) => {
    try {
      const container = docker.getContainer(containerId);
      await container.remove({ force: true });
    } catch (err) {
      if (err.statusCode !== 404) logger.warn('Failed to remove service container', { containerId, error: err.message });
    }
  }));

  if (networkName) {
    try {
      await docker.getNetwork(networkName).remove();
    } catch (err) {
      if (err.statusCode !== 404) logger.warn('Failed to remove service network', { networkName, error: err.message });
    }
  }
}

function streamContainerLogs(container, onLog) {
  container.logs({
    follow: true,
    stdout: true,
    stderr: true,
    tail: 50,
  }).then((logStream) => {
    logStream.on('data', (chunk) => {
      // Docker log streams have an 8-byte header per frame.
      const line = chunk.toString('utf-8').replace(/^.{8}/, '').trim();
      if (line) onLog(line);
    });
  }).catch(err => onLog(`Unable to stream container logs: ${err.message}`));
}

function runDockerCli(args, cwd, onLog) {
  return new Promise((resolve, reject) => {
    const executable = process.platform === 'win32' ? 'docker.exe' : 'docker';
    const child = spawn(executable, args, { cwd, windowsHide: true });
    let stderr = '';

    child.stdout.on('data', data => onLog(data.toString().trim()));
    child.stderr.on('data', data => {
      const line = data.toString().trim();
      stderr += line;
      onLog(line);
    });
    child.on('error', err => {
      reject(new Error(`Docker Compose requires the Docker CLI and Compose plugin: ${err.message}`));
    });
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `docker ${args.join(' ')} exited with code ${code}`));
    });
  });
}

function findComposePreviewContainer(containers) {
  const databasePorts = new Set([3306, 5432, 5672, 6379, 27017]);
  return containers.find(container => container.Ports && container.Ports.some(port => port.PublicPort && !databasePorts.has(port.PrivatePort)))
    || containers.find(container => container.Ports && container.Ports.some(port => port.PublicPort))
    || null;
}

/**
 * Start a repository-owned Docker Compose project and expose its first
 * non-database published port as the preview endpoint.
 */
async function runCompose(sessionId, clonePath, onLog = () => {}) {
  const projectName = resourceName('reporun', sessionId);
  onLog('Starting existing Docker Compose configuration…');
  await runDockerCli(['compose', '--project-name', projectName, 'up', '--detach', '--build', '--remove-orphans'], clonePath, onLog);

  const containers = await docker.listContainers({
    all: true,
    filters: { label: [`com.docker.compose.project=${projectName}`] },
  });
  const previewContainer = findComposePreviewContainer(containers);
  if (!previewContainer) {
    await runDockerCli(['compose', '--project-name', projectName, 'down', '--volumes', '--remove-orphans'], clonePath, onLog).catch(() => {});
    throw new Error('Docker Compose started, but no application service exposes a host port for preview.');
  }

  const port = previewContainer.Ports.find(item => item.PublicPort && ![3306, 5432, 5672, 6379, 27017].includes(item.PrivatePort))
    || previewContainer.Ports.find(item => item.PublicPort);
  const container = docker.getContainer(previewContainer.Id);
  streamContainerLogs(container, onLog);

  return {
    containerId: previewContainer.Id,
    previewUrl: `http://localhost:${port.PublicPort}`,
    terminalUrl: `ws://localhost:${config.port}/ws/terminal?sessionId=${sessionId}`,
    ports: { host: port.PublicPort, container: port.PrivatePort },
    serviceContainerIds: containers.map(containerInfo => containerInfo.Id),
    composeProject: projectName,
    composePath: clonePath,
  };
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

  const runtime = await provisionServices(sessionId, containerConfig.services, onLog);
  let hostPort;
  let container;

  try {
    for (let retry = 0; retry < 10; retry++) {
      hostPort = await allocatePort();
      const containerName = `${resourceName('reporun-app', sessionId)}${retry > 0 ? `-${retry}` : ''}`;

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
            NetworkMode: runtime.networkName || undefined,
            Memory: memoryBytes,
            NanoCpus: config.maxContainerCpu * 1e9,
            SecurityOpt: ['no-new-privileges'],
            CapDrop: ['ALL'],
            CapAdd: ['CHOWN', 'SETGID', 'SETUID', 'NET_BIND_SERVICE'],
          },
          NetworkingConfig: runtime.networkName ? {
            EndpointsConfig: { [runtime.networkName]: { Aliases: ['app'] } },
          } : undefined,
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

    streamContainerLogs(container, onLog);

    const previewUrl = `http://localhost:${hostPort}`;
    const terminalUrl = `ws://localhost:${config.port}/ws/terminal?sessionId=${sessionId}`;

    return {
      containerId: container.id,
      previewUrl,
      terminalUrl,
      ports: { host: hostPort, container: containerPort },
      ...runtime,
    };
  } catch (err) {
    if (hostPort) releasePort(hostPort);
    if (container) await container.remove({ force: true }).catch(() => {});
    await cleanupServices(runtime.serviceContainerIds, runtime.networkName);
    throw err;
  }
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
async function stopContainer(containerId, runtime = {}) {
  if (runtime.composeProject && runtime.composePath) {
    await runDockerCli(
      ['compose', '--project-name', runtime.composeProject, 'down', '--volumes', '--remove-orphans'],
      runtime.composePath,
      () => {},
    ).catch(err => logger.warn('Failed to stop Compose project', { project: runtime.composeProject, error: err.message }));
    return;
  }

  try {
    if (containerId) {
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
    }

    await cleanupServices(runtime.serviceContainerIds, runtime.networkName);
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
  runCompose,
  runContainer,
  stopContainer,
  attachTerminal,
  checkDocker,
  allocatePort,
  releasePort,
};
