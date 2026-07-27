/**
 * Cache Manager — per-repo resolution caching.
 *
 * Community-trained: once a human resolves something for a repo
 * (a start command, a package choice, env var names), that resolution
 * is stored and reused for every future user of that same repo.
 *
 * MVP uses JSON file storage. Production would use Redis/DB.
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../utils/logger');

const CACHE_FILE = path.join(config.cacheDir, 'repo-resolutions.json');

/** @type {Map<string, Object>} In-memory cache */
let cache = new Map();

// ── Load cache from disk on startup ──
function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
      cache = new Map(Object.entries(data));
      logger.info('Cache loaded', { entries: cache.size });
    }
  } catch (err) {
    logger.warn('Failed to load cache', { error: err.message });
    cache = new Map();
  }
}

// ── Persist cache to disk ──
function saveCache() {
  try {
    const dir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const data = Object.fromEntries(cache);
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    logger.warn('Failed to save cache', { error: err.message });
  }
}

/**
 * Get cached resolution for a repo.
 * @param {string} repoKey - "owner/repo"
 * @returns {Object|null}
 */
function get(repoKey) {
  const entry = cache.get(repoKey);
  if (entry) {
    entry.hitCount = (entry.hitCount || 0) + 1;
    entry.lastAccessedAt = new Date().toISOString();
    logger.info('Cache hit', { repoKey, hitCount: entry.hitCount });
    return entry;
  }
  return null;
}

/**
 * Store a resolution for a repo.
 * @param {string} repoKey - "owner/repo"
 * @param {Object} data - Resolution data
 */
function set(repoKey, data) {
  const existing = cache.get(repoKey) || {};
  cache.set(repoKey, {
    ...existing,
    ...data,
    hitCount: existing.hitCount || 0,
    createdAt: existing.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  // Debounced save
  saveCache();
  logger.info('Cache updated', { repoKey });
}

/**
 * Delete cache for a specific repo.
 */
function remove(repoKey) {
  cache.delete(repoKey);
  saveCache();
}

/**
 * Get all cached repo keys.
 */
function listAll() {
  return Array.from(cache.entries()).map(([key, value]) => ({
    repoKey: key,
    hitCount: value.hitCount || 0,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }));
}

/**
 * Get cache statistics.
 */
function getStats() {
  let totalHits = 0;
  for (const entry of cache.values()) {
    totalHits += entry.hitCount || 0;
  }
  return {
    totalEntries: cache.size,
    totalHits,
  };
}

/**
 * Clear the entire cache.
 */
function clear() {
  cache.clear();
  saveCache();
}

// Load on module init
loadCache();

module.exports = { get, set, remove, listAll, getStats, clear };
