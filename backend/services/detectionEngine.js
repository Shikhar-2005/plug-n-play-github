/**
 * Detection Engine — the hard part.
 *
 * Heuristic, file-based detection of a repo's tech stack.
 * Priority order:
 *   1. devcontainer.json / .devcontainer/
 *   2. Dockerfile / docker-compose.yml
 *   3. package.json (Node.js)
 *   4. requirements.txt / pyproject.toml / Pipfile (Python)
 *   5. go.mod (Go)
 *   6. Cargo.toml (Rust)        — v2
 *   7. pom.xml / build.gradle   — v2
 *   8. Gemfile (Ruby)            — v2
 *   9. composer.json (PHP)       — v2
 *  10. README fallback (NLP-assisted)
 *
 * Each detection returns a structured result with a confidence score.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

/**
 * @typedef {Object} DetectionResult
 * @property {string}   language        - Primary language (node, python, go, docker, devcontainer, unknown)
 * @property {string|null} framework    - Detected framework (nextjs, express, flask, django, fastapi, gin, etc.)
 * @property {string|null} version      - Language/runtime version
 * @property {string|null} packageManager - npm, yarn, pnpm, pip, poetry, pipenv, go
 * @property {string|null} startCommand - Best-guess start command
 * @property {string[]} services        - Required services (postgres, redis, mongo, etc.)
 * @property {'high'|'medium'|'low'} confidence
 * @property {string[]} detectedFiles   - Files that contributed to detection
 * @property {Object}   raw            - Raw parsed data for debugging
 * @property {boolean}  hasDockerfile   - Whether a Dockerfile already exists
 * @property {boolean}  hasDevcontainer - Whether devcontainer config exists
 * @property {boolean}  hasDockerCompose- Whether docker-compose exists
 * @property {string|null} monorepoType - nx, lerna, turbo, pnpm-workspace, cargo-workspace, or null
 * @property {string[]|null} monorepoPackages - List of packages if monorepo
 */

/**
 * Run the full detection pipeline on a cloned repo.
 * @param {string} repoPath - Absolute path to cloned repo
 * @param {{ owner: string, repo: string }} meta - Repo metadata
 * @returns {DetectionResult}
 */
async function detect(repoPath, meta = {}) {
  const result = {
    language: 'unknown',
    framework: null,
    version: null,
    packageManager: null,
    startCommand: null,
    services: [],
    confidence: 'low',
    detectedFiles: [],
    raw: {},
    hasDockerfile: false,
    hasDevcontainer: false,
    hasDockerCompose: false,
    monorepoType: null,
    monorepoPackages: null,
  };

  const files = listFiles(repoPath);
  const fileSet = new Set(files.map(f => f.toLowerCase()));
  const hasFile = (name) => fileSet.has(name.toLowerCase());

  // ── 1. DevContainer (highest trust) ──
  if (hasFile('devcontainer.json') || hasFile('.devcontainer/devcontainer.json') || hasFile('.devcontainer.json')) {
    result.hasDevcontainer = true;
    result.detectedFiles.push('devcontainer.json');
    const dcPath = findFile(repoPath, [
      '.devcontainer/devcontainer.json',
      '.devcontainer.json',
      'devcontainer.json',
    ]);
    if (dcPath) {
      try {
        const dc = JSON.parse(fs.readFileSync(dcPath, 'utf-8'));
        result.raw.devcontainer = dc;
        result.language = 'devcontainer';
        result.confidence = 'high';
        if (dc.postCreateCommand) result.startCommand = dc.postCreateCommand;
        logger.info('Detected devcontainer', { path: dcPath });
        return result;
      } catch (e) {
        logger.warn('Failed to parse devcontainer.json', { error: e.message });
      }
    }
  }

  // ── 2. Docker Compose ──
  if (hasFile('docker-compose.yml') || hasFile('docker-compose.yaml') || hasFile('compose.yml') || hasFile('compose.yaml')) {
    result.hasDockerCompose = true;
    const composePath = findFile(repoPath, [
      'docker-compose.yml', 'docker-compose.yaml',
      'compose.yml', 'compose.yaml',
    ]);
    if (composePath) {
      result.detectedFiles.push(path.basename(composePath));
      result.language = 'docker-compose';
      result.confidence = 'high';
      result.startCommand = 'docker-compose up';

      // Parse services from compose file
      const composeContent = fs.readFileSync(composePath, 'utf-8');
      result.services = extractComposeServices(composeContent);
      result.raw.compose = composeContent;

      logger.info('Detected docker-compose', { services: result.services });
      return result;
    }
  }

  // ── 3. Dockerfile ──
  if (hasFile('dockerfile')) {
    result.hasDockerfile = true;
    result.detectedFiles.push('Dockerfile');
    result.language = 'docker';
    result.confidence = 'high';
    result.startCommand = 'docker build -t app . && docker run app';
    logger.info('Detected Dockerfile');
    // Don't return — still try to detect language for enrichment
  }

  // ── 4. Monorepo detection ──
  const monorepo = detectMonorepo(repoPath, hasFile);
  if (monorepo) {
    result.monorepoType = monorepo.type;
    result.monorepoPackages = monorepo.packages;
    result.detectedFiles.push(monorepo.configFile);
  }

  // ── 5. Node.js ──
  if (hasFile('package.json')) {
    const detected = detectNode(repoPath);
    if (detected) {
      mergeDetection(result, detected);
      result.detectedFiles.push('package.json');
      if (!result.hasDockerfile) {
        result.confidence = detected.startCommand ? 'high' : 'medium';
      }
      return result;
    }
  }

  // ── 6. Python ──
  const pythonFile = findFile(repoPath, ['requirements.txt', 'pyproject.toml', 'Pipfile', 'setup.py', 'setup.cfg']);
  if (pythonFile) {
    const detected = detectPython(repoPath, path.basename(pythonFile));
    if (detected) {
      mergeDetection(result, detected);
      result.detectedFiles.push(path.basename(pythonFile));
      if (!result.hasDockerfile) {
        result.confidence = detected.startCommand ? 'high' : 'medium';
      }
      return result;
    }
  }

  // ── 7. Go ──
  if (hasFile('go.mod')) {
    const detected = detectGo(repoPath);
    if (detected) {
      mergeDetection(result, detected);
      result.detectedFiles.push('go.mod');
      if (!result.hasDockerfile) {
        result.confidence = detected.startCommand ? 'high' : 'medium';
      }
      return result;
    }
  }

  // ── 8. Rust (v2, basic detection) ──
  if (hasFile('cargo.toml')) {
    result.language = 'rust';
    result.packageManager = 'cargo';
    result.startCommand = 'cargo run';
    result.confidence = result.hasDockerfile ? 'high' : 'medium';
    result.detectedFiles.push('Cargo.toml');
    return result;
  }

  // ── 9. Java/Kotlin ──
  if (hasFile('pom.xml')) {
    result.language = 'java';
    result.packageManager = 'maven';
    result.startCommand = 'mvn spring-boot:run';
    result.confidence = result.hasDockerfile ? 'high' : 'low';
    result.detectedFiles.push('pom.xml');
    return result;
  }
  if (hasFile('build.gradle') || hasFile('build.gradle.kts')) {
    result.language = 'java';
    result.packageManager = 'gradle';
    result.startCommand = './gradlew bootRun';
    result.confidence = result.hasDockerfile ? 'high' : 'low';
    result.detectedFiles.push('build.gradle');
    return result;
  }

  // ── 10. Ruby ──
  if (hasFile('gemfile')) {
    result.language = 'ruby';
    result.packageManager = 'bundler';
    result.startCommand = 'bundle exec rails server';
    result.confidence = 'low';
    result.detectedFiles.push('Gemfile');
    return result;
  }

  // ── 11. PHP ──
  if (hasFile('composer.json')) {
    result.language = 'php';
    result.packageManager = 'composer';
    result.startCommand = 'php -S 0.0.0.0:8000 -t public';
    result.confidence = 'low';
    result.detectedFiles.push('composer.json');
    return result;
  }

  // ── 12. Static HTML / Web App ──
  if (hasFile('index.html') || hasFile('index.htm') || hasFile('public/index.html') || hasFile('src/index.html')) {
    result.language = 'html';
    result.framework = 'static';
    result.startCommand = 'nginx -g "daemon off;"';
    result.confidence = 'high';
    result.detectedFiles.push('index.html');
    return result;
  }

  // ── 13. README fallback ──
  if (hasFile('readme.md') || hasFile('readme')) {
    const readmePath = findFile(repoPath, ['README.md', 'readme.md', 'README', 'README.rst']);
    if (readmePath) {
      const commands = extractReadmeCommands(readmePath);
      if (commands.length > 0) {
        result.startCommand = commands[commands.length - 1]; // Last command is usually the run command
        result.raw.readmeCommands = commands;
        result.detectedFiles.push(path.basename(readmePath));
        result.confidence = 'low';
      }
    }
  }

  // If we have a Dockerfile but nothing else, that's still high confidence
  if (result.hasDockerfile && result.language === 'unknown') {
    result.language = 'docker';
    result.confidence = 'high';
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// ── Merge Helper ──
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Safely merge detected fields into the result object.
 * Only overwrites fields that have defined, non-null values in the source,
 * preserving existing boolean flags and arrays already set on the target.
 */
function mergeDetection(target, source) {
  const preserveKeys = new Set([
    'hasDockerfile', 'hasDevcontainer', 'hasDockerCompose',
    'detectedFiles', 'monorepoType', 'monorepoPackages',
  ]);
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || value === null) continue;
    if (preserveKeys.has(key) && target[key]) continue; // Don't overwrite if already set
    if (key === 'services' && Array.isArray(target.services) && target.services.length > 0) {
      // Merge services arrays
      target.services = [...new Set([...target.services, ...value])];
    } else {
      target[key] = value;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ── Node.js Detection ──
// ─────────────────────────────────────────────────────────────────────────────

function detectNode(repoPath) {
  const pkgPath = path.join(repoPath, 'package.json');
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const result = {
      language: 'node',
      framework: null,
      version: null,
      packageManager: 'npm',
      startCommand: null,
      services: [],
      raw: { packageJson: pkg },
    };

    // Detect package manager from lockfile
    if (fs.existsSync(path.join(repoPath, 'yarn.lock'))) {
      result.packageManager = 'yarn';
    } else if (fs.existsSync(path.join(repoPath, 'pnpm-lock.yaml'))) {
      result.packageManager = 'pnpm';
    } else if (fs.existsSync(path.join(repoPath, 'bun.lockb')) || fs.existsSync(path.join(repoPath, 'bun.lock'))) {
      result.packageManager = 'bun';
    }

    // Detect Node version
    if (pkg.engines && pkg.engines.node) {
      result.version = pkg.engines.node;
    }
    // .nvmrc fallback
    const nvmrcPath = path.join(repoPath, '.nvmrc');
    if (!result.version && fs.existsSync(nvmrcPath)) {
      result.version = fs.readFileSync(nvmrcPath, 'utf-8').trim();
    }

    // Detect start command
    const scripts = pkg.scripts || {};
    if (scripts.dev) {
      result.startCommand = `${result.packageManager} run dev`;
    } else if (scripts.start) {
      result.startCommand = `${result.packageManager} start`;
    } else if (scripts.serve) {
      result.startCommand = `${result.packageManager} run serve`;
    } else if (pkg.main) {
      result.startCommand = `node ${pkg.main}`;
    }

    // Detect framework from dependencies
    const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    if (allDeps['next']) {
      result.framework = 'nextjs';
    } else if (allDeps['nuxt'] || allDeps['nuxt3']) {
      result.framework = 'nuxt';
    } else if (allDeps['@angular/core']) {
      result.framework = 'angular';
    } else if (allDeps['react'] && allDeps['react-scripts']) {
      result.framework = 'create-react-app';
    } else if (allDeps['react']) {
      result.framework = 'react';
    } else if (allDeps['vue']) {
      result.framework = 'vue';
    } else if (allDeps['svelte'] || allDeps['@sveltejs/kit']) {
      result.framework = allDeps['@sveltejs/kit'] ? 'sveltekit' : 'svelte';
    } else if (allDeps['express']) {
      result.framework = 'express';
    } else if (allDeps['fastify']) {
      result.framework = 'fastify';
    } else if (allDeps['koa']) {
      result.framework = 'koa';
    } else if (allDeps['hono']) {
      result.framework = 'hono';
    } else if (allDeps['nest'] || allDeps['@nestjs/core']) {
      result.framework = 'nestjs';
    }

    // Detect required services from deps
    if (allDeps['pg'] || allDeps['postgres'] || allDeps['@prisma/client']) result.services.push('postgres');
    if (allDeps['redis'] || allDeps['ioredis']) result.services.push('redis');
    if (allDeps['mongodb'] || allDeps['mongoose']) result.services.push('mongodb');
    if (allDeps['mysql'] || allDeps['mysql2']) result.services.push('mysql');

    return result;
  } catch (e) {
    logger.warn('Failed to parse package.json', { error: e.message });
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ── Python Detection ──
// ─────────────────────────────────────────────────────────────────────────────

function detectPython(repoPath, manifestFile) {
  const result = {
    language: 'python',
    framework: null,
    version: null,
    packageManager: 'pip',
    startCommand: null,
    services: [],
    raw: {},
  };

  // Detect package manager
  if (manifestFile === 'Pipfile') {
    result.packageManager = 'pipenv';
  } else if (manifestFile === 'pyproject.toml') {
    const content = fs.readFileSync(path.join(repoPath, manifestFile), 'utf-8');
    if (content.includes('[tool.poetry]')) {
      result.packageManager = 'poetry';
    }
    result.raw.pyproject = content;
  }

  // Detect Python version
  const pvPath = path.join(repoPath, '.python-version');
  if (fs.existsSync(pvPath)) {
    result.version = fs.readFileSync(pvPath, 'utf-8').trim();
  }

  // Detect framework from requirements/deps
  const depsContent = readDepsContent(repoPath, manifestFile);

  if (depsContent.includes('django')) {
    result.framework = 'django';
    result.startCommand = 'python manage.py runserver 0.0.0.0:8000';
    // Check for manage.py
    if (!fs.existsSync(path.join(repoPath, 'manage.py'))) {
      // Try to find it in subdirectories
      const managePy = findFileRecursive(repoPath, 'manage.py', 2);
      if (managePy) {
        const relPath = path.relative(repoPath, path.dirname(managePy));
        result.startCommand = `cd ${relPath} && python manage.py runserver 0.0.0.0:8000`;
      }
    }
  } else if (depsContent.includes('flask')) {
    result.framework = 'flask';
    result.startCommand = 'flask run --host=0.0.0.0';
    // Check for common entry points
    for (const entry of ['app.py', 'application.py', 'main.py', 'run.py']) {
      if (fs.existsSync(path.join(repoPath, entry))) {
        result.startCommand = `python ${entry}`;
        break;
      }
    }
  } else if (depsContent.includes('fastapi')) {
    result.framework = 'fastapi';
    // Common FastAPI entry points
    for (const entry of ['main.py', 'app.py', 'app/main.py', 'src/main.py']) {
      if (fs.existsSync(path.join(repoPath, entry))) {
        const module = entry.replace(/\.py$/, '').replace(/\//g, '.');
        result.startCommand = `uvicorn ${module}:app --host 0.0.0.0 --port 8000 --reload`;
        break;
      }
    }
    if (!result.startCommand) {
      result.startCommand = 'uvicorn main:app --host 0.0.0.0 --port 8000';
    }
  } else if (depsContent.includes('streamlit')) {
    result.framework = 'streamlit';
    // Find the main streamlit file
    for (const entry of ['app.py', 'main.py', 'streamlit_app.py']) {
      if (fs.existsSync(path.join(repoPath, entry))) {
        result.startCommand = `streamlit run ${entry} --server.address 0.0.0.0`;
        break;
      }
    }
  } else {
    // Generic Python — look for common entry points
    for (const entry of ['main.py', 'app.py', 'run.py', 'server.py']) {
      if (fs.existsSync(path.join(repoPath, entry))) {
        result.startCommand = `python ${entry}`;
        break;
      }
    }
  }

  // Detect required services
  if (depsContent.includes('psycopg') || depsContent.includes('sqlalchemy')) result.services.push('postgres');
  if (depsContent.includes('redis')) result.services.push('redis');
  if (depsContent.includes('pymongo')) result.services.push('mongodb');
  if (depsContent.includes('mysqlclient') || depsContent.includes('pymysql')) result.services.push('mysql');
  if (depsContent.includes('celery')) result.services.push('redis'); // Celery commonly uses Redis

  return result;
}

function readDepsContent(repoPath, manifestFile) {
  try {
    const content = fs.readFileSync(path.join(repoPath, manifestFile), 'utf-8').toLowerCase();
    // Also check requirements.txt if it exists alongside pyproject/Pipfile
    const reqPath = path.join(repoPath, 'requirements.txt');
    if (manifestFile !== 'requirements.txt' && fs.existsSync(reqPath)) {
      return content + '\n' + fs.readFileSync(reqPath, 'utf-8').toLowerCase();
    }
    return content;
  } catch {
    return '';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ── Go Detection ──
// ─────────────────────────────────────────────────────────────────────────────

function detectGo(repoPath) {
  const goModPath = path.join(repoPath, 'go.mod');
  try {
    const content = fs.readFileSync(goModPath, 'utf-8');
    const result = {
      language: 'go',
      framework: null,
      version: null,
      packageManager: 'go',
      startCommand: 'go run .',
      services: [],
      raw: { goMod: content },
    };

    // Extract Go version
    const versionMatch = content.match(/^go\s+(\d+\.\d+(?:\.\d+)?)/m);
    if (versionMatch) {
      result.version = versionMatch[1];
    }

    // Detect framework
    if (content.includes('github.com/gin-gonic/gin')) {
      result.framework = 'gin';
    } else if (content.includes('github.com/gofiber/fiber')) {
      result.framework = 'fiber';
    } else if (content.includes('github.com/labstack/echo')) {
      result.framework = 'echo';
    } else if (content.includes('github.com/gorilla/mux')) {
      result.framework = 'gorilla';
    }

    // Check for cmd directory (Go convention)
    const cmdDir = path.join(repoPath, 'cmd');
    if (fs.existsSync(cmdDir) && fs.statSync(cmdDir).isDirectory()) {
      const cmds = fs.readdirSync(cmdDir).filter(f => {
        const p = path.join(cmdDir, f);
        return fs.statSync(p).isDirectory();
      });
      if (cmds.length === 1) {
        result.startCommand = `go run ./cmd/${cmds[0]}`;
      } else if (cmds.length > 1) {
        result.startCommand = `go run ./cmd/${cmds[0]}`; // Default to first
        result.raw.availableCmds = cmds;
      }
    }

    // Detect services
    if (content.includes('github.com/lib/pq') || content.includes('github.com/jackc/pgx')) {
      result.services.push('postgres');
    }
    if (content.includes('github.com/go-redis/redis') || content.includes('github.com/redis/go-redis')) {
      result.services.push('redis');
    }
    if (content.includes('go.mongodb.org/mongo-driver')) {
      result.services.push('mongodb');
    }

    return result;
  } catch (e) {
    logger.warn('Failed to parse go.mod', { error: e.message });
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ── Monorepo Detection ──
// ─────────────────────────────────────────────────────────────────────────────

function detectMonorepo(repoPath, hasFile) {
  // Nx
  if (hasFile('nx.json')) {
    return {
      type: 'nx',
      configFile: 'nx.json',
      packages: listMonorepoPackages(repoPath, ['apps', 'packages', 'libs']),
    };
  }

  // Lerna
  if (hasFile('lerna.json')) {
    return {
      type: 'lerna',
      configFile: 'lerna.json',
      packages: listMonorepoPackages(repoPath, ['packages']),
    };
  }

  // Turborepo
  if (hasFile('turbo.json')) {
    return {
      type: 'turbo',
      configFile: 'turbo.json',
      packages: listMonorepoPackages(repoPath, ['apps', 'packages']),
    };
  }

  // pnpm workspace
  if (hasFile('pnpm-workspace.yaml')) {
    return {
      type: 'pnpm-workspace',
      configFile: 'pnpm-workspace.yaml',
      packages: listMonorepoPackages(repoPath, ['packages', 'apps']),
    };
  }

  return null;
}

function listMonorepoPackages(repoPath, possibleDirs) {
  const packages = [];
  for (const dir of possibleDirs) {
    const dirPath = path.join(repoPath, dir);
    if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          packages.push(`${dir}/${entry.name}`);
        }
      }
    }
  }
  return packages.length > 0 ? packages : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// ── README Command Extraction (lightweight NLP fallback) ──
// ─────────────────────────────────────────────────────────────────────────────

function extractReadmeCommands(readmePath) {
  try {
    const content = fs.readFileSync(readmePath, 'utf-8');
    const commands = [];

    // Match fenced code blocks (```bash, ```shell, ```sh, or plain ```)
    const codeBlockRe = /```(?:bash|shell|sh|zsh|console)?\s*\n([\s\S]*?)```/gi;
    let match;
    while ((match = codeBlockRe.exec(content)) !== null) {
      const block = match[1].trim();
      const lines = block.split('\n')
        .map(l => l.replace(/^\$\s*/, '').trim())  // Strip $ prompt
        .filter(l => l && !l.startsWith('#'));       // Skip comments
      commands.push(...lines);
    }

    // Filter to likely install/run commands
    const runCommands = commands.filter(cmd =>
      /^(npm|yarn|pnpm|bun|pip|python|go |cargo |ruby |rails |php |node |make|docker|flask|uvicorn|streamlit)/i.test(cmd)
    );

    return runCommands;
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ── Compose Service Extraction ──
// ─────────────────────────────────────────────────────────────────────────────

function extractComposeServices(composeContent) {
  const services = [];
  // Simple YAML parsing — look for known service image names
  const imagePattern = /image:\s*['"]?(\S+?)['"]?\s*$/gm;
  let match;
  while ((match = imagePattern.exec(composeContent)) !== null) {
    const image = match[1].toLowerCase();
    if (image.includes('postgres')) services.push('postgres');
    else if (image.includes('redis')) services.push('redis');
    else if (image.includes('mongo')) services.push('mongodb');
    else if (image.includes('mysql') || image.includes('mariadb')) services.push('mysql');
    else if (image.includes('rabbitmq')) services.push('rabbitmq');
    else if (image.includes('elasticsearch')) services.push('elasticsearch');
    else if (image.includes('nginx')) services.push('nginx');
  }
  return [...new Set(services)];
}

// ─────────────────────────────────────────────────────────────────────────────
// ── File Utilities ──
// ─────────────────────────────────────────────────────────────────────────────

/**
 * List all files in a directory (1 level deep + known subdirs).
 */
function listFiles(dirPath) {
  const files = [];
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        files.push(entry.name);
      } else if (entry.isDirectory() && ['.devcontainer', 'cmd', 'src', 'app'].includes(entry.name)) {
        // Check one level deeper for known important subdirs
        const subEntries = fs.readdirSync(path.join(dirPath, entry.name), { withFileTypes: true });
        for (const sub of subEntries) {
          if (sub.isFile()) {
            files.push(`${entry.name}/${sub.name}`);
          }
        }
      }
    }
  } catch {
    // ignore errors
  }
  return files;
}

/**
 * Find the first existing file from a list of candidate paths.
 */
function findFile(basePath, candidates) {
  for (const candidate of candidates) {
    const fullPath = path.join(basePath, candidate);
    if (fs.existsSync(fullPath)) return fullPath;
  }
  return null;
}

/**
 * Recursively find a file up to a max depth.
 */
function findFileRecursive(basePath, filename, maxDepth, currentDepth = 0) {
  if (currentDepth > maxDepth) return null;
  try {
    const entries = fs.readdirSync(basePath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name === filename) {
        return path.join(basePath, entry.name);
      }
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        const found = findFileRecursive(path.join(basePath, entry.name), filename, maxDepth, currentDepth + 1);
        if (found) return found;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

module.exports = { detect };
