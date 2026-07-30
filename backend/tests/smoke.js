const assert = require('assert');
const { generate } = require('../services/configGenerator');

function detection(overrides = {}) {
  return {
    language: 'node',
    framework: 'express',
    packageManager: 'npm',
    startCommand: 'npm start',
    services: [],
    hasDockerfile: false,
    raw: {},
    ...overrides,
  };
}

const viteConfig = generate(detection({
  framework: 'vite',
  startCommand: 'npm run dev',
}));
assert(viteConfig.dockerfile.includes('npm run dev -- --host 0.0.0.0'));
assert(viteConfig.dockerfile.includes('CMD ["/bin/sh","-c",'));
assert.strictEqual(viteConfig.envVars.HOST, '0.0.0.0');

const databaseConfig = generate(detection({ services: ['postgres', 'redis'] }));
assert(databaseConfig.services.postgres);
assert(databaseConfig.services.redis);
assert(databaseConfig.envVars.DATABASE_URL.includes('@postgres:'));
assert.strictEqual(databaseConfig.envVars.REDIS_HOST, 'redis');

const workspaceConfig = generate(detection({
  framework: 'vite',
  startCommand: 'npm run dev',
  workspacePackage: 'apps/web',
}));
assert(workspaceConfig.dockerfile.includes('WORKDIR /app/apps/web'));

const existingDockerfileConfig = generate(detection({ hasDockerfile: true }));
assert.strictEqual(existingDockerfileConfig.useExistingDockerfile, true);
assert.strictEqual(existingDockerfileConfig.existingDockerfilePath, 'Dockerfile');

const composeConfig = generate(detection({
  hasDockerCompose: true,
}));
assert.strictEqual(composeConfig.useExistingCompose, true);

assert.throws(
  () => generate(detection({ language: 'devcontainer', raw: { devcontainer: {} } })),
  err => err.code === 'UNSUPPORTED_DEVCONTAINER',
);

console.log('RepoRun smoke tests passed.');
