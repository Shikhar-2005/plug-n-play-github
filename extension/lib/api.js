/**
 * RepoRun API Client — shared API communication layer
 * used by both the content script and popup.
 */

const REPORUN_API = (() => {
  const DEFAULT_BASE_URL = 'http://localhost:3000';

  /**
   * Get the configured backend URL.
   */
  async function getBaseUrl() {
    try {
      const result = await chrome.storage.local.get('backendUrl');
      return result.backendUrl || DEFAULT_BASE_URL;
    } catch {
      return DEFAULT_BASE_URL;
    }
  }

  /**
   * Make an API request.
   */
  async function request(endpoint, options = {}) {
    const base = await getBaseUrl();
    const url = `${base}${endpoint}`;

    const response = await fetch(url, {
      headers: { 'Content-Type': 'application/json', ...options.headers },
      ...options,
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const err = new Error(body.error?.message || `API error: ${response.status}`);
      err.status = response.status;
      err.code = body.error?.code;
      throw err;
    }

    return response.json();
  }

  /**
   * Check backend health.
   */
  async function healthCheck() {
    try {
      const data = await request('/api/health');
      return { healthy: true, ...data };
    } catch (err) {
      return { healthy: false, error: err.message };
    }
  }

  /**
   * Analyze a repo without running it.
   */
  async function analyzeRepo(repoUrl) {
    return request('/api/repo/analyze', {
      method: 'POST',
      body: JSON.stringify({ repoUrl }),
    });
  }

  /**
   * Start the full run pipeline. Returns sessionId immediately.
   */
  async function runRepo(repoUrl, overrides = {}) {
    return request('/api/repo/run', {
      method: 'POST',
      body: JSON.stringify({ repoUrl, overrides }),
    });
  }

  /**
   * Subscribe to SSE progress stream for a session.
   * Returns an EventSource instance.
   */
  async function subscribeProgress(sessionId, handlers = {}) {
    const base = await getBaseUrl();
    const es = new EventSource(`${base}/api/repo/status/${sessionId}`);

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (handlers.onMessage) handlers.onMessage(data);

        // Route to specific handlers
        if (data.type === 'step' && handlers.onStep) handlers.onStep(data);
        if (data.type === 'ready' && handlers.onReady) handlers.onReady(data);
        if (data.type === 'error' && handlers.onError) handlers.onError(data);
        if (data.type === 'resolution_needed' && handlers.onResolution) handlers.onResolution(data);
        if (data.type === 'build_log' && handlers.onBuildLog) handlers.onBuildLog(data);
        if (data.type === 'run_log' && handlers.onRunLog) handlers.onRunLog(data);
      } catch (e) {
        console.error('[RepoRun] SSE parse error:', e);
      }
    };

    es.onerror = (err) => {
      if (handlers.onError) handlers.onError({ type: 'error', message: 'Connection lost' });
    };

    return es;
  }

  /**
   * Submit resolutions for a paused session.
   */
  async function submitResolution(sessionId, resolutions) {
    return request(`/api/resolution/${sessionId}`, {
      method: 'POST',
      body: JSON.stringify({ resolutions }),
    });
  }

  /**
   * Get all active sessions.
   */
  async function getSessions() {
    return request('/api/sessions');
  }

  /**
   * Stop a session.
   */
  async function stopSession(sessionId) {
    return request(`/api/session/${sessionId}`, { method: 'DELETE' });
  }

  return {
    getBaseUrl,
    healthCheck,
    analyzeRepo,
    runRepo,
    subscribeProgress,
    submitResolution,
    getSessions,
    stopSession,
  };
})();
