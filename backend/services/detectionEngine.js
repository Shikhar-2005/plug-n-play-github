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
 * @property {boolean}  requiresGpu     - Whether GPU/CUDA support appears required
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
    requiresGpu: false,
  };

  const files = listFiles(repoPath);
  const fileSet = new Set(files.map(f => f.toLowerCase()));
  const hasFile = (name) => fileSet.has(name.toLowerCase());

  // ── 1. DevContainer metadata ──
  // Keep looking for the application itself. A devcontainer describes a
  // development environment, not necessarily the command that serves the app.
  if (hasFile('devcontainer.json') || hasFile('.devcontainer/devcontainer.json') || hasFile('.devcontainer.json')) {
    result.hasDevcontainer = true;
    const dcPath = findFile(repoPath, [
      '.devcontainer/devcontainer.json',
      '.devcontainer.json',
      'devcontainer.json',
    ]);
    if (dcPath) {
      try {
        const dc = JSON.parse(fs.readFileSync(dcPath, 'utf-8'));
        result.raw.devcontainer = dc;
        result.detectedFiles.push(path.relative(repoPath, dcPath));
        logger.info('Detected devcontainer', { path: dcPath });
      } catch (e) {
        logger.warn('Failed to parse devcontainer.json', { error: e.message });
      }
    }
  }

  // ── 2. Docker Compose metadata ──
  // A compose file can sit alongside a Node/Python application. In that case
  // the language detector below provides a more useful runnable entrypoint.
  if (hasFile('docker-compose.yml') || hasFile('docker-compose.yaml') || hasFile('compose.yml') || hasFile('compose.yaml')) {
    result.hasDockerCompose = true;
    const composePath = findFile(repoPath, [
      'docker-compose.yml', 'docker-compose.yaml',
      'compose.yml', 'compose.yaml',
    ]);
    if (composePath) {
      result.detectedFiles.push(path.basename(composePath));
      // Parse services from compose file
      const composeContent = fs.readFileSync(composePath, 'utf-8');
      result.services = extractComposeServices(composeContent);
      result.raw.compose = composeContent;

      logger.info('Detected docker-compose', { services: result.services });
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

  // ── 4b. GPU detection ──
  result.requiresGpu = detectGpu(repoPath, files);

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
  const htmlFiles = files.filter(f => f.toLowerCase().endsWith('.html') || f.toLowerCase().endsWith('.htm'));
  if (htmlFiles.length > 0) {
    result.language = 'html';
    result.framework = 'static';
    result.startCommand = 'nginx -g "daemon off;"';
    result.confidence = 'high';
    result.detectedFiles.push(path.basename(htmlFiles[0]));
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

  // If Compose is the only runnable configuration, run it directly.
  if (result.hasDockerCompose && result.language === 'unknown') {
    result.language = 'docker-compose';
    result.confidence = 'high';
    result.startCommand = 'docker compose up';
  }

  // If a devcontainer is the only configuration, retain it so the caller can
  // use its Dockerfile when one is declared, or report a precise limitation.
  if (result.hasDevcontainer && result.language === 'unknown') {
    result.language = 'devcontainer';
    result.confidence = 'medium';
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
    if (scripts.dev && !scripts.dev.includes('echo "Error')) {
      result.startCommand = `${result.packageManager} run dev`;
    } else if (scripts.start && scripts.start !== 'node index.js') {
      result.startCommand = `${result.packageManager} start`;
    } else if (scripts.serve) {
      result.startCommand = `${result.packageManager} run serve`;
    } else {
      // Automatically verify actual entry point on disk (resolving default npm init index.js mismatches)
      const possibleMains = [];
      if (pkg.main && fs.existsSync(path.join(repoPath, pkg.main))) {
        possibleMains.push(pkg.main);
      }
      possibleMains.push(
        'server.js', 'app.js', 'main.js', 'api.js', 'index.js',
        'src/server.js', 'src/app.js', 'src/main.js', 'src/index.js'
      );
      const actualEntry = possibleMains.find(file => fs.existsSync(path.join(repoPath, file)));
      if (actualEntry) {
        result.startCommand = `node ${actualEntry}`;
      } else if (scripts.start) {
        result.startCommand = `${result.packageManager} start`;
      } else if (pkg.main) {
        result.startCommand = `node ${pkg.main}`;
      }
    }

    // Detect framework from dependencies
    const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };

    // Bail out for bare npm-init projects that are really static HTML sites.
    // If no valid start command was found, no server-side framework is present,
    // and the repo has .html files, let detection fall through to the static
    // HTML template (Nginx) instead of generating a broken `node index.js`.
    if (!result.startCommand) {
      const serverDeps = ['express', 'fastify', 'koa', 'hono', '@nestjs/core', 'next', 'nuxt', 'nuxt3', 'vite', 'react-scripts', '@angular/core'];
      const hasServerDep = serverDeps.some(dep => allDeps[dep]);
      const hasHtmlFiles = fs.readdirSync(repoPath).some(f => /\.html?$/i.test(f));
      if (!hasServerDep && hasHtmlFiles) {
        logger.info('Bare package.json with HTML files — deferring to static HTML detection');
        return null;
      }
    }

    if (allDeps['vite']) {
      result.framework = 'vite';
    } else if (allDeps['next']) {
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

    // Detect split frontend/backend pattern: index.html alongside a server entry point
    const hasIndexHtml = fs.existsSync(path.join(repoPath, 'index.html'));
    const entryIsServer = result.startCommand && /^node\s+(server|app|api|main)/.test(result.startCommand);
    if (hasIndexHtml && entryIsServer && allDeps['express']) {
      result.hasStaticFrontend = true;
    }

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
// ── GPU / CUDA Detection ──
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect whether a repository requires GPU/CUDA support.
 * Checks Python/Node/Go dependency files and scans source code for CUDA usage.
 */
function detectGpu(repoPath, files) {
  const fileSet = new Set(files.map(f => f.toLowerCase()));

  // ── Check Python deps for GPU libraries ──
  const pythonDepFiles = ['requirements.txt', 'pyproject.toml', 'pipfile', 'setup.py', 'setup.cfg'];
  for (const depFile of pythonDepFiles) {
    if (fileSet.has(depFile)) {
      try {
        const content = fs.readFileSync(path.join(repoPath, depFile), 'utf-8').toLowerCase();
        const gpuLibs = ['torch', 'tensorflow', 'tensorflow-gpu', 'cupy', 'nvidia-', 'cuda-python',
          'jax[cuda', 'pycuda', 'numba', 'rapids', 'cudf', 'cuml', 'onnxruntime-gpu'];
        if (gpuLibs.some(lib => content.includes(lib))) {
          logger.info('GPU requirement detected from Python deps', { file: depFile });
          return true;
        }
      } catch { /* ignore */ }
    }
  }

  // ── Check Node.js deps for GPU libraries ──
  if (fileSet.has('package.json')) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(repoPath, 'package.json'), 'utf-8'));
      const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      const gpuNodeLibs = ['@tensorflow/tfjs-node-gpu', 'gpu.js', 'cuda'];
      if (gpuNodeLibs.some(lib => allDeps[lib])) {
        logger.info('GPU requirement detected from Node deps');
        return true;
      }
    } catch { /* ignore */ }
  }

  // ── Scan source files for CUDA / GPU imports ──
  const sourceExts = ['.py', '.cu', '.cuh', '.cpp', '.c', '.go', '.rs'];
  const cudaPatterns = [
    /import\s+(?:torch|tensorflow|cupy|pycuda)/i,
    /from\s+(?:torch|tensorflow|cupy|pycuda)\s+import/i,
    /#include\s*[<"]cuda/i,
    /cuda\.h/i,
    /cudaMalloc|cudaMemcpy|cudaFree/,
    /torch\.cuda\.is_available/,
    /tf\.config\..*gpu/i,
    /with\s+tf\.device.*gpu/i,
  ];

  const sourceFiles = collectSourceFiles(repoPath, sourceExts, 2);
  for (const filePath of sourceFiles) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      if (cudaPatterns.some(pattern => pattern.test(content))) {
        logger.info('GPU requirement detected from source code', { file: path.relative(repoPath, filePath) });
        return true;
      }
    } catch { /* ignore */ }
  }

  // ── Check for .cu files (CUDA source) ──
  if (files.some(f => f.toLowerCase().endsWith('.cu') || f.toLowerCase().endsWith('.cuh'))) {
    logger.info('GPU requirement detected from .cu files');
    return true;
  }

  return false;
}

/**
 * Collect source files with given extensions up to a max depth.
 */
function collectSourceFiles(dirPath, extensions, maxDepth, currentDepth = 0) {
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
        results.push(...collectSourceFiles(fullPath, extensions, maxDepth, currentDepth + 1));
      }
    }
  } catch { /* ignore */ }
  return results;
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
