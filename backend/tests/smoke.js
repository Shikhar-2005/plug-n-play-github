const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ─────────────────────────────────────────────────────────────────────────────
// ── Config Generator Tests (existing) ──
// ─────────────────────────────────────────────────────────────────────────────

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

console.log('✓ configGenerator tests passed');

// ─────────────────────────────────────────────────────────────────────────────
// ── Secret Scanner Tests ──
// ─────────────────────────────────────────────────────────────────────────────

const { scan, AUTO_PROVISIONED, SAFE_DEFAULTS } = require('../utils/secretScanner');

(async () => {
  // Create a temporary repo directory with a .env.example
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reporun-test-'));
  try {
    // Write a .env.example with various types of vars
    fs.writeFileSync(path.join(tmpDir, '.env.example'), [
      '# The API key for OpenAI',
      'OPENAI_API_KEY=',
      '# Database connection string',
      'DATABASE_URL=postgresql://localhost:5432/dev',
      '# App port',
      'PORT=3000',
      'NODE_ENV=production',
      'CUSTOM_SECRET=',
    ].join('\n'));

    const results = await scan(tmpDir, { language: 'node' });

    // DATABASE_URL should be auto-provisioned
    const dbVar = results.find(r => r.name === 'DATABASE_URL');
    assert(dbVar, 'DATABASE_URL should be detected');
    assert.strictEqual(dbVar.autoProvision, true, 'DATABASE_URL should be auto-provisioned');

    // PORT should have a safe default
    const portVar = results.find(r => r.name === 'PORT');
    assert(portVar, 'PORT should be detected');
    assert.strictEqual(portVar.required, false, 'PORT should not be required');
    assert.strictEqual(portVar.defaultValue, '3000', 'PORT should have safe default');

    // NODE_ENV should have a safe default
    const nodeEnv = results.find(r => r.name === 'NODE_ENV');
    assert(nodeEnv, 'NODE_ENV should be detected');
    assert.strictEqual(nodeEnv.required, false, 'NODE_ENV should not be required');

    // OPENAI_API_KEY should be required and have a service link
    const openai = results.find(r => r.name === 'OPENAI_API_KEY');
    assert(openai, 'OPENAI_API_KEY should be detected');
    assert.strictEqual(openai.required, true, 'OPENAI_API_KEY should be required');
    assert(openai.service, 'OPENAI_API_KEY should have a service link');
    assert.strictEqual(openai.service.service, 'OpenAI');

    // CUSTOM_SECRET should be required with no service link
    const custom = results.find(r => r.name === 'CUSTOM_SECRET');
    assert(custom, 'CUSTOM_SECRET should be detected');
    assert.strictEqual(custom.required, true, 'CUSTOM_SECRET should be required');
    assert.strictEqual(custom.service, null, 'CUSTOM_SECRET should have no service link');

    console.log('✓ secretScanner tests passed');
  } finally {
    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ── Session Manager Tests ──
  // ─────────────────────────────────────────────────────────────────────────

  const sessionManager = require('../services/sessionManager');

  // Create a session
  const session = sessionManager.create('testowner', 'testrepo');
  assert(session.id, 'Session should have an id');
  assert.strictEqual(session.status, 'created', 'New session status should be "created"');

  // Get session
  const fetched = sessionManager.get(session.id);
  assert(fetched, 'Session should be retrievable by id');
  assert.strictEqual(fetched.id, session.id);

  // List sessions
  const all = sessionManager.listAll();
  assert(all.some(s => s.id === session.id), 'Session should appear in listAll');

  // Update session
  sessionManager.updateStatus(session.id, 'ready');
  const updated = sessionManager.get(session.id);
  assert.strictEqual(updated.status, 'ready', 'Session status should be updated');

  // Remove session
  sessionManager.remove(session.id);
  const removed = sessionManager.get(session.id);
  assert.strictEqual(removed, null, 'Session should be removed');

  console.log('✓ sessionManager tests passed');

  // ─────────────────────────────────────────────────────────────────────────
  // ── Cache Manager Tests ──
  // ─────────────────────────────────────────────────────────────────────────

  const cacheManager = require('../services/cacheManager');

  // Set and get
  cacheManager.set('test/repo', { startCommand: 'npm start' });
  const cached = cacheManager.get('test/repo');
  assert(cached, 'Cached entry should exist');
  assert.strictEqual(cached.startCommand, 'npm start');
  assert(cached.hitCount >= 1, 'Hit count should increment on get');

  // List
  const list = cacheManager.listAll();
  assert(list.some(e => e.repoKey === 'test/repo'), 'test/repo should appear in listAll');

  // Stats
  const stats = cacheManager.getStats();
  assert(stats.totalEntries >= 1, 'Should have at least 1 entry');
  assert(stats.totalHits >= 1, 'Should have at least 1 hit');

  // Cleanup
  cacheManager.remove('test/repo');
  const afterRemove = cacheManager.get('test/repo');
  assert.strictEqual(afterRemove, null, 'Removed entry should return null');

  console.log('✓ cacheManager tests passed');

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n✅ All RepoRun smoke tests passed.');
})();
