/**
 * Secret Scanner — detects required environment variables / API keys
 * by scanning for .env.example, .env.sample, config schemas, and
 * code-level env reads (process.env.X, os.environ["X"]).
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

/**
 * Well-known services and their API key signup URLs.
 */
const SERVICE_LINKS = {
  STRIPE_API_KEY:       { service: 'Stripe',       url: 'https://dashboard.stripe.com/apikeys' },
  STRIPE_SECRET_KEY:    { service: 'Stripe',       url: 'https://dashboard.stripe.com/apikeys' },
  STRIPE_PUBLISHABLE_KEY: { service: 'Stripe',     url: 'https://dashboard.stripe.com/apikeys' },
  OPENAI_API_KEY:       { service: 'OpenAI',       url: 'https://platform.openai.com/api-keys' },
  AWS_ACCESS_KEY_ID:    { service: 'AWS',           url: 'https://console.aws.amazon.com/iam/' },
  AWS_SECRET_ACCESS_KEY:{ service: 'AWS',           url: 'https://console.aws.amazon.com/iam/' },
  TWILIO_ACCOUNT_SID:   { service: 'Twilio',       url: 'https://console.twilio.com/' },
  TWILIO_AUTH_TOKEN:     { service: 'Twilio',       url: 'https://console.twilio.com/' },
  SENDGRID_API_KEY:     { service: 'SendGrid',     url: 'https://app.sendgrid.com/settings/api_keys' },
  GITHUB_TOKEN:         { service: 'GitHub',        url: 'https://github.com/settings/tokens' },
  FIREBASE_API_KEY:     { service: 'Firebase',      url: 'https://console.firebase.google.com/' },
  SUPABASE_URL:         { service: 'Supabase',      url: 'https://supabase.com/dashboard' },
  SUPABASE_ANON_KEY:    { service: 'Supabase',      url: 'https://supabase.com/dashboard' },
  RESEND_API_KEY:       { service: 'Resend',        url: 'https://resend.com/api-keys' },
  CLERK_SECRET_KEY:     { service: 'Clerk',         url: 'https://dashboard.clerk.com/' },
  ANTHROPIC_API_KEY:    { service: 'Anthropic',     url: 'https://console.anthropic.com/settings/keys' },
  GOOGLE_API_KEY:       { service: 'Google',        url: 'https://console.cloud.google.com/apis/credentials' },
  GOOGLE_CLIENT_ID:     { service: 'Google OAuth',  url: 'https://console.cloud.google.com/apis/credentials' },
  GOOGLE_CLIENT_SECRET: { service: 'Google OAuth',  url: 'https://console.cloud.google.com/apis/credentials' },
  MONGODB_URI:          { service: 'MongoDB',       url: 'https://cloud.mongodb.com/' },
  MONGO_URI:            { service: 'MongoDB',       url: 'https://cloud.mongodb.com/' },
  REDIS_URL:            { service: 'Redis',         url: 'https://redis.io/try-free/' },
};

/**
 * Env var names that are auto-provisioned (DB connection strings, etc.)
 * and should NOT be prompted to the user.
 */
const AUTO_PROVISIONED = new Set([
  'DATABASE_URL', 'DB_URL', 'POSTGRES_URL', 'POSTGRES_HOST', 'POSTGRES_PORT',
  'POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB', 'PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE',
  'REDIS_URL', 'REDIS_HOST', 'REDIS_PORT',
  'MONGODB_URI', 'MONGO_URI', 'MONGO_URL',
  'MYSQL_HOST', 'MYSQL_PORT', 'MYSQL_USER', 'MYSQL_PASSWORD', 'MYSQL_DATABASE',
]);

/**
 * Env vars that have common safe defaults and don't need prompting.
 */
const SAFE_DEFAULTS = {
  NODE_ENV: 'development',
  PORT: '3000',
  HOST: '0.0.0.0',
  DEBUG: '*',
  LOG_LEVEL: 'debug',
  SECRET: 'dev-secret-change-in-production',
  JWT_SECRET: 'dev-jwt-secret-change-in-production',
  SESSION_SECRET: 'dev-session-secret-change-in-production',
  APP_ENV: 'development',
  FLASK_ENV: 'development',
  FLASK_DEBUG: '1',
  DJANGO_DEBUG: 'True',
  DJANGO_SETTINGS_MODULE: '',
};

/**
 * Scan a cloned repo for required environment variables.
 *
 * @param {string} repoPath - Path to cloned repo
 * @param {Object} detection - Detection engine result (for context)
 * @returns {Array<{ name: string, required: boolean, source: string, description: string|null, service: Object|null, autoProvision: boolean, defaultValue: string|null }>}
 */
async function scan(repoPath, detection = {}) {
  const envVars = new Map();

  // 1. Scan .env.example / .env.sample
  const envFiles = ['.env.example', '.env.sample', '.env.template', '.env.local.example'];
  for (const file of envFiles) {
    const filePath = path.join(repoPath, file);
    if (fs.existsSync(filePath)) {
      parseEnvFile(filePath, file, envVars);
    }
  }

  // 2. Scan source code for env reads
  if (detection.language === 'node') {
    scanNodeEnvReads(repoPath, envVars);
  } else if (detection.language === 'python') {
    scanPythonEnvReads(repoPath, envVars);
  } else if (detection.language === 'go') {
    scanGoEnvReads(repoPath, envVars);
  }

  // 3. Process and classify each var
  const results = [];
  for (const [name, info] of envVars) {
    const upperName = name.toUpperCase();

    // Skip auto-provisioned DB vars
    if (AUTO_PROVISIONED.has(upperName)) {
      results.push({
        name,
        required: true,
        source: info.source,
        description: info.description,
        service: SERVICE_LINKS[upperName] || null,
        autoProvision: true,
        defaultValue: null,
      });
      continue;
    }

    // Apply safe defaults
    if (SAFE_DEFAULTS[upperName] !== undefined) {
      results.push({
        name,
        required: false,
        source: info.source,
        description: info.description,
        service: null,
        autoProvision: false,
        defaultValue: SAFE_DEFAULTS[upperName] || info.value || null,
      });
      continue;
    }

    // Everything else — needs user input
    results.push({
      name,
      required: !info.hasDefault,
      source: info.source,
      description: info.description,
      service: SERVICE_LINKS[upperName] || null,
      autoProvision: false,
      defaultValue: info.value || null,
    });
  }

  logger.info('Secret scan complete', {
    total: results.length,
    needInput: results.filter(r => r.required && !r.autoProvision && !r.defaultValue).length,
  });

  return results;
}

/**
 * Parse a .env.example file for variable names and descriptions.
 */
function parseEnvFile(filePath, source, envVars) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    let lastComment = null;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#')) {
        lastComment = trimmed.replace(/^#\s*/, '');
        continue;
      }
      if (!trimmed || !trimmed.includes('=')) {
        lastComment = null;
        continue;
      }

      const eqIndex = trimmed.indexOf('=');
      const name = trimmed.substring(0, eqIndex).trim();
      const value = trimmed.substring(eqIndex + 1).trim().replace(/^["']|["']$/g, '');

      if (name && /^[A-Z_][A-Z0-9_]*$/i.test(name)) {
        envVars.set(name, {
          source,
          description: lastComment,
          value: value || null,
          hasDefault: !!value,
        });
      }
      lastComment = null;
    }
  } catch (e) {
    logger.warn('Failed to parse env file', { path: filePath, error: e.message });
  }
}

/**
 * Scan Node.js source files for process.env.X usage.
 */
function scanNodeEnvReads(repoPath, envVars) {
  const pattern = /process\.env\.([A-Z_][A-Z0-9_]*)/g;
  const pattern2 = /process\.env\[['"]([A-Z_][A-Z0-9_]*)['"]\]/g;
  scanFilesForPattern(repoPath, ['.js', '.ts', '.jsx', '.tsx', '.mjs'], [pattern, pattern2], 'source code', envVars);
}

/**
 * Scan Python source files for os.environ["X"] / os.getenv("X") usage.
 */
function scanPythonEnvReads(repoPath, envVars) {
  const pattern1 = /os\.environ\[['"]([A-Z_][A-Z0-9_]*)['"]\]/g;
  const pattern2 = /os\.environ\.get\(['"]([A-Z_][A-Z0-9_]*)['"]/g;
  const pattern3 = /os\.getenv\(['"]([A-Z_][A-Z0-9_]*)['"]/g;
  scanFilesForPattern(repoPath, ['.py'], [pattern1, pattern2, pattern3], 'source code', envVars);
}

/**
 * Scan Go source files for os.Getenv("X") usage.
 */
function scanGoEnvReads(repoPath, envVars) {
  const pattern = /os\.Getenv\(['"]([A-Z_][A-Z0-9_]*)['"]\)/g;
  scanFilesForPattern(repoPath, ['.go'], [pattern], 'source code', envVars);
}

/**
 * Generic file scanner that applies regex patterns to find env var references.
 */
function scanFilesForPattern(repoPath, extensions, patterns, source, envVars) {
  const filesToScan = collectFiles(repoPath, extensions, 3); // max depth 3

  for (const filePath of filesToScan) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      for (const pattern of patterns) {
        // Reset regex lastIndex
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(content)) !== null) {
          const name = match[1];
          if (!envVars.has(name)) {
            envVars.set(name, {
              source,
              description: null,
              value: null,
              hasDefault: false,
            });
          }
        }
      }
    } catch {
      // skip unreadable files
    }
  }
}

/**
 * Collect files with given extensions up to a max depth.
 */
function collectFiles(dirPath, extensions, maxDepth, currentDepth = 0) {
  if (currentDepth > maxDepth) return [];
  const results = [];
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isFile() && extensions.some(ext => entry.name.endsWith(ext))) {
        results.push(fullPath);
      } else if (entry.isDirectory()
        && !entry.name.startsWith('.')
        && entry.name !== 'node_modules'
        && entry.name !== '__pycache__'
        && entry.name !== 'vendor'
        && entry.name !== 'dist'
        && entry.name !== 'build') {
        results.push(...collectFiles(fullPath, extensions, maxDepth, currentDepth + 1));
      }
    }
  } catch {
    // ignore
  }
  return results;
}

module.exports = { scan, SERVICE_LINKS, AUTO_PROVISIONED, SAFE_DEFAULTS };
