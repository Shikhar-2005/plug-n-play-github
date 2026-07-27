/**
 * Repo Fetcher — handles shallow cloning of GitHub repos with validation.
 */

const simpleGit = require('simple-git');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const config = require('../config');
const logger = require('../utils/logger');

/**
 * Shallow-clone a public GitHub repo into a temp directory.
 * @param {string} owner - GitHub owner
 * @param {string} repo  - GitHub repo name
 * @returns {string} Absolute path to the cloned directory
 */
async function cloneRepo(owner, repo) {
  const repoUrl = `https://github.com/${owner}/${repo}.git`;
  const cloneId = `${owner}-${repo}-${uuidv4().slice(0, 8)}`;
  const clonePath = path.join(config.cloneDir, cloneId);

  logger.info('Cloning repo', { owner, repo, clonePath });

  // Ensure clone directory exists
  if (!fs.existsSync(config.cloneDir)) {
    fs.mkdirSync(config.cloneDir, { recursive: true });
  }

  const git = simpleGit({
    timeout: { block: config.cloneTimeoutMs },
  });

  await git.clone(repoUrl, clonePath, [
    '--depth', '1',       // Shallow clone — we only need the latest snapshot
    '--single-branch',    // Don't fetch other branches
  ]);

  // Check repo size
  const totalSize = getDirSize(clonePath);
  const maxBytes = config.maxRepoSizeMB * 1024 * 1024;
  if (totalSize > maxBytes) {
    await cleanup(clonePath);
    const err = new Error(`Repository too large (${(totalSize / 1024 / 1024).toFixed(1)} MB exceeds ${config.maxRepoSizeMB} MB limit)`);
    err.status = 413;
    err.code = 'REPO_TOO_LARGE';
    err.expose = true;
    throw err;
  }

  logger.info('Clone complete', { owner, repo, sizeMB: (totalSize / 1024 / 1024).toFixed(1) });
  return clonePath;
}

/**
 * Calculate total directory size recursively.
 */
function getDirSize(dirPath) {
  let size = 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '.git') continue; // Skip .git for size calc
        size += getDirSize(fullPath);
      } else {
        size += fs.statSync(fullPath).size;
      }
    }
  } catch {
    // ignore permission errors etc.
  }
  return size;
}

/**
 * Cleanup a cloned repo directory.
 */
async function cleanup(clonePath) {
  try {
    if (fs.existsSync(clonePath)) {
      fs.rmSync(clonePath, { recursive: true, force: true });
      logger.info('Cleaned up clone', { path: clonePath });
    }
  } catch (err) {
    logger.warn('Cleanup failed', { path: clonePath, error: err.message });
  }
}

module.exports = { cloneRepo, cleanup, getDirSize };
