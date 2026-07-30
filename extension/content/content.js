/**
 * RepoRun Content Script
 *
 * Injects a "▶ Run this repo" button on GitHub repository pages.
 * Handles the full UI flow: button → modal → progress → result/resolution.
 */

(() => {
  'use strict';

  // ── State ──
  let currentSessionId = null;
  let currentEventSource = null;
  let isInjected = false;

  // ── Constants ──
  const BUTTON_ID = 'reporun-run-btn';
  const MODAL_ID = 'reporun-modal';

  // ─────────────────────────────────────────────────────────────────────────
  // ── URL Parsing ──
  // ─────────────────────────────────────────────────────────────────────────

  function getRepoInfo() {
    const match = window.location.pathname.match(/^\/([^/]+)\/([^/]+)\/?$/);
    if (!match) return null;
    // Exclude GitHub system pages
    const exclude = ['settings', 'notifications', 'explore', 'topics', 'trending',
      'collections', 'events', 'sponsors', 'login', 'signup', 'new', 'organizations',
      'marketplace', 'features', 'enterprise', 'pricing', 'search'];
    if (exclude.includes(match[1])) return null;
    return { owner: match[1], repo: match[2] };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ── Button Injection ──
  // ─────────────────────────────────────────────────────────────────────────

  function injectButton() {
    if (isInjected || document.getElementById(BUTTON_ID)) return;
    const info = getRepoInfo();
    if (!info) return;

    // Find the GitHub action bar (next to Code, Fork, Star buttons)
    const targetSelectors = [
      // New GitHub UI
      '.pagehead-actions',
      '[class*="HeaderActions"]',
      // Repository header buttons area
      '.file-navigation',
      // Fallback: the repo header
      '.repohead-details-container',
      // Newer layout
      '.Layout-sidebar .BorderGrid-row:first-child',
    ];

    let target = null;
    for (const sel of targetSelectors) {
      target = document.querySelector(sel);
      if (target) break;
    }

    // Broader fallback: look for the About section or any suitable spot
    if (!target) {
      // Try to find the repo-level nav or any header area
      target = document.querySelector('[data-testid="repo-header-actions"]')
        || document.querySelector('.UnderlineNav-body')
        || document.querySelector('.repository-content');
    }

    if (!target) {
      // Ultimate fallback — inject as a floating button
      createFloatingButton(info);
      return;
    }

    const btn = createButton(info);

    // Insert at the beginning if it's an actions list
    if (target.classList.contains('pagehead-actions')) {
      const li = document.createElement('li');
      li.appendChild(btn);
      target.insertBefore(li, target.firstChild);
    } else {
      // Insert before the target's first child or append
      const wrapper = document.createElement('div');
      wrapper.style.cssText = 'display:inline-flex; margin:8px 8px 8px 0; vertical-align:middle;';
      wrapper.appendChild(btn);
      target.insertBefore(wrapper, target.firstChild);
    }

    isInjected = true;
  }

  function createButton(info) {
    const btn = document.createElement('button');
    btn.id = BUTTON_ID;
    btn.className = 'reporun-btn';
    btn.innerHTML = `
      <svg class="reporun-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polygon points="5 3 19 12 5 21 5 3" fill="currentColor" stroke="none"/>
      </svg>
      <span class="reporun-btn-text">Run this repo</span>
    `;
    btn.title = 'Run this repo with RepoRun';

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      startRun(info);
    });

    return btn;
  }

  function createFloatingButton(info) {
    const btn = createButton(info);
    btn.classList.add('reporun-btn-floating');
    document.body.appendChild(btn);
    isInjected = true;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ── Modal ──
  // ─────────────────────────────────────────────────────────────────────────

  function showModal() {
    // Remove existing modal if any
    removeModal();

    const overlay = document.createElement('div');
    overlay.id = MODAL_ID;
    overlay.className = 'reporun-overlay';
    overlay.innerHTML = `
      <div class="reporun-modal">
        <div class="reporun-modal-header">
          <div class="reporun-modal-logo">
            <svg viewBox="0 0 24 24" fill="none" width="28" height="28">
              <circle cx="12" cy="12" r="11" stroke="url(#rr-grad)" stroke-width="2" fill="none"/>
              <polygon points="9.5 7 17 12 9.5 17" fill="url(#rr-grad)"/>
              <defs>
                <linearGradient id="rr-grad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" style="stop-color:#6366f1"/>
                  <stop offset="100%" style="stop-color:#a855f7"/>
                </linearGradient>
              </defs>
            </svg>
            <span class="reporun-modal-title">RepoRun</span>
          </div>
          <button class="reporun-modal-close" id="reporun-close-btn" title="Close">&times;</button>
        </div>
        <div class="reporun-modal-body" id="reporun-modal-body">
          <!-- Content injected dynamically -->
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    // Close handlers
    document.getElementById('reporun-close-btn').addEventListener('click', () => {
      closeModal();
    });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeModal();
    });
  }

  function closeModal() {
    if (currentEventSource) {
      currentEventSource.close();
      currentEventSource = null;
    }
    removeModal();
  }

  function removeModal() {
    const existing = document.getElementById(MODAL_ID);
    if (existing) existing.remove();
  }

  function getModalBody() {
    return document.getElementById('reporun-modal-body');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ── Run Pipeline ──
  // ─────────────────────────────────────────────────────────────────────────

  async function startRun(info) {
    showModal();
    const body = getModalBody();
    const repoUrl = `https://github.com/${info.owner}/${info.repo}`;

    try {
      // Check backend health
      const health = await REPORUN_API.healthCheck();
      if (!health.healthy) {
        showError(body, 'Cannot connect to RepoRun backend', `Make sure the backend server is running at ${await REPORUN_API.getBaseUrl()}`);
        return;
      }
      if (health.docker && !health.docker.available) {
        showError(body, 'Docker Desktop is not ready', `RepoRun can reach its backend, but it cannot build containers: ${health.docker.error || 'Docker engine unavailable'}`);
        return;
      }

      // Show analyzing state
      body.innerHTML = `
        <div class="reporun-analyzing">
          <div class="reporun-spinner reporun-spinner-lg"></div>
          <h3 class="reporun-analyzing-title">Analyzing repository…</h3>
          <p class="reporun-analyzing-subtitle">${info.owner}/${info.repo}</p>
        </div>
      `;

      // First, analyze the repo to get detection info + confidence
      const analysis = await REPORUN_API.analyzeRepo(repoUrl);
      const confidence = analysis.detection?.confidence || 'low';

      // Route based on confidence
      if (confidence === 'high') {
        // Auto-run — skip confirmation
        executeRun(info, repoUrl, body);
      } else if (confidence === 'medium') {
        // Show confirmation with detected stack
        showConfirmation(body, info, repoUrl, analysis);
      } else {
        // Show manual wizard
        showWizard(body, info, repoUrl, analysis);
      }

    } catch (err) {
      showError(body, 'Failed to analyze repo', err.message);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ── Confidence UX: Confirmation (Medium) ──
  // ─────────────────────────────────────────────────────────────────────────

  function showConfirmation(body, info, repoUrl, analysis) {
    const d = analysis.detection || {};
    const lang = d.language || 'unknown';
    const framework = d.framework ? ` · ${d.framework}` : '';
    const pm = d.packageManager ? ` (${d.packageManager})` : '';
    const startCmd = d.startCommand || 'auto-detect';
    const services = (d.services || []).join(', ') || 'none';

    body.innerHTML = `
      <div class="reporun-confirm">
        <div class="reporun-confirm-header">
          <svg viewBox="0 0 24 24" width="32" height="32" fill="none">
            <circle cx="12" cy="12" r="11" stroke="#6366f1" stroke-width="2"/>
            <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z" fill="#6366f1"/>
          </svg>
          <div>
            <h3 class="reporun-confirm-title">Stack Detected</h3>
            <p class="reporun-confirm-subtitle">We detected the following — confirm or adjust before running.</p>
          </div>
        </div>

        <div class="reporun-confirm-details">
          <div class="reporun-detail-row">
            <span class="reporun-detail-label">Language</span>
            <span class="reporun-detail-value">${lang}${framework}${pm}</span>
          </div>
          <div class="reporun-detail-row">
            <span class="reporun-detail-label">Start Command</span>
            <input type="text" class="reporun-detail-input" id="reporun-confirm-cmd" value="${startCmd === 'auto-detect' ? '' : startCmd}" placeholder="auto-detect" />
          </div>
          <div class="reporun-detail-row">
            <span class="reporun-detail-label">Services</span>
            <span class="reporun-detail-value">${services}</span>
          </div>
          ${d.requiresGpu ? `
            <div class="reporun-detail-row reporun-detail-warning">
              <span class="reporun-detail-label">\u26a0\ufe0f GPU</span>
              <span class="reporun-detail-value">This repo may require GPU/CUDA support</span>
            </div>
          ` : ''}
        </div>

        <div class="reporun-confirm-actions">
          <button class="reporun-action-btn reporun-action-primary" id="reporun-confirm-run">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
              <polygon points="5 3 19 12 5 21 5 3" fill="currentColor" stroke="none"/>
            </svg>
            Looks good — Run it!
          </button>
          <button class="reporun-action-btn reporun-action-secondary" id="reporun-confirm-edit">
            Edit Config
          </button>
        </div>
      </div>
    `;

    document.getElementById('reporun-confirm-run').addEventListener('click', () => {
      const cmdOverride = document.getElementById('reporun-confirm-cmd').value.trim();
      const overrides = cmdOverride ? { startCommand: cmdOverride } : {};
      executeRun(info, repoUrl, body, overrides);
    });

    document.getElementById('reporun-confirm-edit').addEventListener('click', () => {
      showWizard(body, info, repoUrl, analysis);
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ── Confidence UX: Manual Wizard (Low) ──
  // ─────────────────────────────────────────────────────────────────────────

  function showWizard(body, info, repoUrl, analysis) {
    const d = analysis.detection || {};
    const detectedLang = d.language || '';
    const detectedCmd = d.startCommand || '';
    const languages = ['node', 'python', 'go', 'rust', 'java', 'ruby', 'php', 'docker', 'html'];

    const langOptions = languages.map(lang =>
      `<option value="${lang}" ${lang === detectedLang ? 'selected' : ''}>${lang.charAt(0).toUpperCase() + lang.slice(1)}</option>`
    ).join('');

    body.innerHTML = `
      <div class="reporun-wizard">
        <div class="reporun-wizard-header">
          <svg viewBox="0 0 24 24" width="32" height="32" fill="none">
            <circle cx="12" cy="12" r="11" stroke="#f59e0b" stroke-width="2"/>
            <line x1="12" y1="8" x2="12" y2="13" stroke="#f59e0b" stroke-width="2" stroke-linecap="round"/>
            <circle cx="12" cy="16.5" r="1" fill="#f59e0b"/>
          </svg>
          <div>
            <h3 class="reporun-wizard-title">Manual Setup</h3>
            <p class="reporun-wizard-subtitle">We couldn't auto-detect the full config. Help us fill in the blanks.</p>
          </div>
        </div>

        <div class="reporun-wizard-fields">
          <div class="reporun-wizard-field">
            <label class="reporun-wizard-label">Language / Runtime</label>
            <select class="reporun-wizard-select" id="reporun-wizard-lang">
              <option value="">Auto-detect</option>
              ${langOptions}
            </select>
          </div>

          <div class="reporun-wizard-field">
            <label class="reporun-wizard-label">Start Command</label>
            <input type="text" class="reporun-wizard-input" id="reporun-wizard-cmd"
              value="${detectedCmd}" placeholder="e.g., npm run dev, python app.py, go run ." />
            <p class="reporun-wizard-hint">The command used to start the application</p>
          </div>

          <div class="reporun-wizard-field">
            <label class="reporun-wizard-label">Environment Variables <span class="reporun-wizard-optional">(optional)</span></label>
            <textarea class="reporun-wizard-textarea" id="reporun-wizard-env"
              placeholder="KEY=value&#10;ANOTHER_KEY=value" rows="3"></textarea>
            <p class="reporun-wizard-hint">One per line, KEY=value format</p>
          </div>
        </div>

        <button class="reporun-action-btn reporun-action-primary reporun-submit-btn" id="reporun-wizard-run">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
            <polygon points="5 3 19 12 5 21 5 3" fill="currentColor" stroke="none"/>
          </svg>
          Run with this config
        </button>
      </div>
    `;

    document.getElementById('reporun-wizard-run').addEventListener('click', () => {
      const lang = document.getElementById('reporun-wizard-lang').value;
      const cmd = document.getElementById('reporun-wizard-cmd').value.trim();
      const envText = document.getElementById('reporun-wizard-env').value.trim();

      const overrides = {};
      if (lang) overrides.language = lang;
      if (cmd) overrides.startCommand = cmd;
      if (envText) {
        const envVars = {};
        envText.split('\n').forEach(line => {
          const eqIdx = line.indexOf('=');
          if (eqIdx > 0) {
            envVars[line.substring(0, eqIdx).trim()] = line.substring(eqIdx + 1).trim();
          }
        });
        if (Object.keys(envVars).length > 0) overrides.envVars = envVars;
      }

      executeRun(info, repoUrl, body, overrides);
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ── Execute Run (shared by all confidence paths) ──
  // ─────────────────────────────────────────────────────────────────────────

  async function executeRun(info, repoUrl, body, overrides = {}) {
    // Show progress view
    body.innerHTML = renderProgress({
      repoName: `${info.owner}/${info.repo}`,
      steps: [
        { id: 'clone', label: 'Cloning repository', status: 'pending' },
        { id: 'detect', label: 'Detecting tech stack', status: 'pending' },
        { id: 'config', label: 'Generating config', status: 'pending' },
        { id: 'build', label: 'Building container', status: 'pending' },
        { id: 'run', label: 'Starting app', status: 'pending' },
      ],
      logs: [],
    });

    try {
      // Start the run
      const result = await REPORUN_API.runRepo(repoUrl, overrides);
      currentSessionId = result.sessionId;

      // Store session
      chrome.storage.local.get('sessions', (data) => {
        const sessions = data.sessions || [];
        sessions.unshift({ id: result.sessionId, owner: info.owner, repo: info.repo, startedAt: new Date().toISOString() });
        chrome.storage.local.set({ sessions: sessions.slice(0, 20) }); // Keep last 20
      });

      // Subscribe to SSE progress
      let readyFired = false;
      let readyTimeout = null;
      const seenLogs = new Set();

      function handleReady(data) {
        if (readyFired) return;
        readyFired = true;
        if (readyTimeout) clearTimeout(readyTimeout);
        showReady(body, data, info);
      }

      // Fallback: poll session API for ready status after container starts
      function scheduleReadyPoll() {
        if (readyFired || readyTimeout) return;
        readyTimeout = setTimeout(async () => {
          if (readyFired) return;
          try {
            const base = await REPORUN_API.getBaseUrl();
            const resp = await fetch(`${base}/api/session/${currentSessionId}`);
            const { session } = await resp.json();
            if (session && session.status === 'ready' && session.previewUrl) {
              handleReady({
                previewUrl: session.previewUrl,
                terminalUrl: session.terminalUrl,
                ports: session.ports,
              });
            } else {
              // Retry once more after 3s
              readyTimeout = setTimeout(async () => {
                if (readyFired) return;
                try {
                  const resp2 = await fetch(`${base}/api/session/${currentSessionId}`);
                  const { session: s2 } = await resp2.json();
                  if (s2 && s2.status === 'ready' && s2.previewUrl) {
                    handleReady({
                      previewUrl: s2.previewUrl,
                      terminalUrl: s2.terminalUrl,
                      ports: s2.ports,
                    });
                  }
                } catch (e) { /* ignore */ }
              }, 3000);
            }
          } catch (e) { /* ignore */ }
        }, 2000);
      }

      currentEventSource = await REPORUN_API.subscribeProgress(result.sessionId, {
        onStep: (data) => {
          updateStep(data.step, data.status, data.message);
          // When the run step completes, start polling as a safety net
          if (data.step === 'run' && data.status === 'done') {
            scheduleReadyPoll();
          }
        },
        onBuildLog: (data) => {
          if (seenLogs.has(data.message)) return;
          seenLogs.add(data.message);
          appendLog(data.message, 'build');
        },
        onRunLog: (data) => {
          if (seenLogs.has(data.message)) return;
          seenLogs.add(data.message);
          appendLog(data.message, 'run');
          // Detect container app readiness from log output as a backup trigger
          const msg = (data.message || '').toLowerCase();
          if (msg.includes('listening') || msg.includes('server running') ||
              msg.includes('started on') || msg.includes('ready on') ||
              msg.includes('accepting connections')) {
            scheduleReadyPoll();
          }
        },
        onReady: (data) => handleReady(data),
        onError: (data) => {
          if (!readyFired) showError(body, 'Pipeline Error', data.message);
        },
        onResolution: (data) => showResolutionPrompts(body, data.resolutions, info),
      });

    } catch (err) {
      showError(body, 'Failed to start run', err.message);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ── Progress Rendering ──
  // ─────────────────────────────────────────────────────────────────────────

  function renderProgress(state) {
    const stepsHtml = state.steps.map(step => `
      <div class="reporun-step" data-step-id="${step.id}" data-status="${step.status}">
        <div class="reporun-step-indicator">
          ${step.status === 'running'
            ? '<div class="reporun-spinner"></div>'
            : step.status === 'done'
              ? '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z" fill="#22c55e"/></svg>'
              : '<div class="reporun-step-dot"></div>'
          }
        </div>
        <span class="reporun-step-label">${step.label}</span>
        ${step.status === 'running' && step.message ? `<span class="reporun-step-detail">${step.message}</span>` : ''}
      </div>
    `).join('');

    return `
      <div class="reporun-progress">
        <div class="reporun-repo-badge">
          <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
            <path d="M2 2.5A2.5 2.5 0 014.5 0h8.75a.75.75 0 01.75.75v12.5a.75.75 0 01-.75.75h-2.5a.75.75 0 110-1.5h1.75v-2h-8a1 1 0 00-.714 1.7.75.75 0 01-1.072 1.05A2.495 2.495 0 012 11.5v-9z"/>
          </svg>
          <span>${state.repoName}</span>
        </div>
        <div class="reporun-steps">
          ${stepsHtml}
        </div>
        <div class="reporun-logs" id="reporun-logs">
          <div class="reporun-logs-header">
            <span>Build Output</span>
            <button class="reporun-logs-toggle" id="reporun-logs-toggle">▼</button>
          </div>
          <div class="reporun-logs-content" id="reporun-logs-content"></div>
        </div>
      </div>
    `;
  }

  function updateStep(stepId, status, message) {
    const stepEl = document.querySelector(`[data-step-id="${stepId}"]`);
    if (!stepEl) return;

    stepEl.dataset.status = status;

    const indicator = stepEl.querySelector('.reporun-step-indicator');
    if (status === 'running') {
      indicator.innerHTML = '<div class="reporun-spinner"></div>';
    } else if (status === 'done') {
      indicator.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z" fill="#22c55e"/></svg>';
    }

    // Update message
    let detail = stepEl.querySelector('.reporun-step-detail');
    if (message && status === 'running') {
      if (!detail) {
        detail = document.createElement('span');
        detail.className = 'reporun-step-detail';
        stepEl.appendChild(detail);
      }
      detail.textContent = message;
    } else if (detail) {
      detail.remove();
    }
  }

  function appendLog(message, type = 'build') {
    const logsContent = document.getElementById('reporun-logs-content');
    if (!logsContent) return;

    const line = document.createElement('div');
    line.className = `reporun-log-line reporun-log-${type}`;
    line.textContent = message;
    logsContent.appendChild(line);
    logsContent.scrollTop = logsContent.scrollHeight;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ── Ready State ──
  // ─────────────────────────────────────────────────────────────────────────

  function showReady(body, data, info) {
    if (currentEventSource) {
      currentEventSource.close();
      currentEventSource = null;
    }

    body.innerHTML = `
      <div class="reporun-ready">
        <div class="reporun-ready-icon">
          <svg viewBox="0 0 24 24" width="48" height="48" fill="none">
            <circle cx="12" cy="12" r="11" stroke="#22c55e" stroke-width="2"/>
            <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z" fill="#22c55e"/>
          </svg>
        </div>
        <h2 class="reporun-ready-title">Ready to go!</h2>
        <p class="reporun-ready-subtitle">${info.owner}/${info.repo} is running</p>

        <div class="reporun-ready-actions">
          ${data.previewUrl ? `
            <a href="${data.previewUrl}" target="_blank" class="reporun-action-btn reporun-action-primary" id="reporun-open-preview">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/>
                <polyline points="15 3 21 3 21 9"/>
                <line x1="10" y1="14" x2="21" y2="3"/>
              </svg>
              Open Preview
            </a>
          ` : ''}
          <button class="reporun-action-btn reporun-action-secondary" id="reporun-open-terminal">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="4 17 10 11 4 5"/>
              <line x1="12" y1="19" x2="20" y2="19"/>
            </svg>
            Open Terminal
          </button>
        </div>

        <div class="reporun-ready-meta">
          <div class="reporun-meta-item">
            <span class="reporun-meta-label">Port</span>
            <span class="reporun-meta-value">${data.ports?.host || '—'}</span>
          </div>
          <div class="reporun-meta-item">
            <span class="reporun-meta-label">Session</span>
            <span class="reporun-meta-value reporun-session-id">${currentSessionId?.slice(0, 8) || '—'}</span>
          </div>
        </div>

        <button class="reporun-stop-btn" id="reporun-stop-session">
          Stop Session
        </button>
      </div>
    `;

    // Bind events
    const stopBtn = document.getElementById('reporun-stop-session');
    if (stopBtn) {
      stopBtn.addEventListener('click', async () => {
        stopBtn.textContent = 'Stopping…';
        stopBtn.disabled = true;
        try {
          await REPORUN_API.stopSession(currentSessionId);
          closeModal();
        } catch (err) {
          stopBtn.textContent = 'Stop Session';
          stopBtn.disabled = false;
        }
      });
    }

    const terminalBtn = document.getElementById('reporun-open-terminal');
    if (terminalBtn && data.terminalUrl) {
      terminalBtn.addEventListener('click', async () => {
        const baseUrl = await REPORUN_API.getBaseUrl();
        const dashUrl = `${baseUrl}/dashboard?session=${currentSessionId}`;
        window.open(dashUrl, '_blank');
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ── Resolution Prompts ──
  // ─────────────────────────────────────────────────────────────────────────

  function showResolutionPrompts(body, resolutions, info) {
    const fieldsHtml = resolutions.map(res => {
      if (res.type === 'missing_secret') {
        return `
          <div class="reporun-resolution-field">
            <label class="reporun-field-label">
              <span class="reporun-field-name">${res.name}</span>
              ${res.service ? `<a href="${res.service.url}" target="_blank" class="reporun-field-link">Get ${res.service.service} key →</a>` : ''}
            </label>
            <p class="reporun-field-desc">${res.description}</p>
            <input type="text" class="reporun-field-input" data-res-id="${res.id}" data-env-name="${res.name}"
              placeholder="${res.placeholder || `Enter ${res.name}`}" autocomplete="off" spellcheck="false"/>
            <p class="reporun-field-security">🔒 Held in-memory only for this session — never stored or logged</p>
          </div>
        `;
      }

      if (res.type === 'package_selection') {
        const optionsHtml = res.options.map(opt => `
          <label class="reporun-radio-option">
            <input type="radio" name="reporun-package" value="${opt.value}"/>
            <span>${opt.label}</span>
          </label>
        `).join('');
        return `
          <div class="reporun-resolution-field">
            <label class="reporun-field-label">${res.description}</label>
            <div class="reporun-radio-group">${optionsHtml}</div>
          </div>
        `;
      }

      if (res.type === 'ambiguous_entrypoint') {
        return `
          <div class="reporun-resolution-field">
            <label class="reporun-field-label">${res.description}</label>
            ${res.hint ? `<p class="reporun-field-hint">${res.hint}</p>` : ''}
            <input type="text" class="reporun-field-input" data-res-id="${res.id}" data-field="startCommand"
              placeholder="${res.placeholder || 'e.g., npm run dev'}" autocomplete="off"/>
          </div>
        `;
      }

      if (res.type === 'gpu_required') {
        const optionsHtml = res.options.map(opt => `
          <label class="reporun-radio-option">
            <input type="radio" name="reporun-gpu-choice" value="${opt.value}"/>
            <span>${opt.label}</span>
          </label>
        `).join('');
        return `
          <div class="reporun-resolution-field reporun-gpu-notice">
            <label class="reporun-field-label">GPU support required</label>
            <p class="reporun-field-desc">${res.description}</p>
            <div class="reporun-radio-group">${optionsHtml}</div>
          </div>
        `;
      }

      return '';
    }).join('');

    body.innerHTML = `
      <div class="reporun-resolution">
        <div class="reporun-resolution-header">
          <svg viewBox="0 0 24 24" width="32" height="32" fill="none">
            <circle cx="12" cy="12" r="11" stroke="#f59e0b" stroke-width="2"/>
            <line x1="12" y1="8" x2="12" y2="13" stroke="#f59e0b" stroke-width="2" stroke-linecap="round"/>
            <circle cx="12" cy="16.5" r="1" fill="#f59e0b"/>
          </svg>
          <div>
            <h3 class="reporun-resolution-title">Almost there!</h3>
            <p class="reporun-resolution-subtitle">This repo needs a few things before it can run.</p>
          </div>
        </div>

        <div class="reporun-resolution-fields">
          ${fieldsHtml}
        </div>

        <button class="reporun-action-btn reporun-action-primary reporun-submit-btn" id="reporun-submit-resolution">
          Continue →
        </button>
      </div>
    `;

    // Submit handler
    document.getElementById('reporun-submit-resolution').addEventListener('click', async () => {
      const envVars = {};
      const inputs = body.querySelectorAll('.reporun-field-input[data-env-name]');
      inputs.forEach(input => {
        if (input.value.trim()) {
          envVars[input.dataset.envName] = input.value.trim();
        }
      });

      const startCommandInput = body.querySelector('[data-field="startCommand"]');
      const startCommand = startCommandInput ? startCommandInput.value.trim() : null;

      const selectedPackage = body.querySelector('input[name="reporun-package"]:checked');
      const gpuChoice = body.querySelector('input[name="reporun-gpu-choice"]:checked');

      const requiredSecretMissing = resolutions.some(res => res.type === 'missing_secret' && res.required
        && !envVars[res.name]);
      const entrypointMissing = resolutions.some(res => res.type === 'ambiguous_entrypoint' && res.required)
        && !startCommand;
      const packageMissing = resolutions.some(res => res.type === 'package_selection' && res.required)
        && !selectedPackage;
      const gpuChoiceMissing = resolutions.some(res => res.type === 'gpu_required' && res.required)
        && !gpuChoice;

      if (requiredSecretMissing || entrypointMissing || packageMissing || gpuChoiceMissing) {
        let validation = body.querySelector('.reporun-resolution-validation');
        if (!validation) {
          validation = document.createElement('p');
          validation.className = 'reporun-resolution-validation';
          body.querySelector('.reporun-resolution-fields').appendChild(validation);
        }
        validation.textContent = 'Complete each required field before continuing.';
        return;
      }

      const resolutionsData = {
        envVars: Object.keys(envVars).length > 0 ? envVars : undefined,
        startCommand: startCommand || undefined,
        selectedPackage: selectedPackage ? selectedPackage.value : undefined,
        gpuChoice: gpuChoice ? gpuChoice.value : undefined,
      };

      const submitBtn = document.getElementById('reporun-submit-resolution');
      submitBtn.textContent = 'Resuming…';
      submitBtn.disabled = true;

      try {
        await REPORUN_API.submitResolution(currentSessionId, resolutionsData);
        // Re-show progress view
        if (currentEventSource) currentEventSource.close();
        showModal();
        const mbody = getModalBody();
        mbody.innerHTML = renderProgress({
          repoName: `${info.owner}/${info.repo}`,
          steps: [
            { id: 'clone', label: 'Cloning repository', status: 'done' },
            { id: 'detect', label: 'Detecting tech stack', status: 'done' },
            { id: 'config', label: 'Generating config', status: 'running' },
            { id: 'build', label: 'Building container', status: 'pending' },
            { id: 'run', label: 'Starting app', status: 'pending' },
          ],
          logs: [],
        });

        // Re-subscribe to SSE with readiness fallback
        let readyFired2 = false;
        let readyTimeout2 = null;
        const seenLogs2 = new Set();

        function handleReady2(data) {
          if (readyFired2) return;
          readyFired2 = true;
          if (readyTimeout2) clearTimeout(readyTimeout2);
          showReady(mbody, data, info);
        }

        function scheduleReadyPoll2() {
          if (readyFired2 || readyTimeout2) return;
          readyTimeout2 = setTimeout(async () => {
            if (readyFired2) return;
            try {
              const base = await REPORUN_API.getBaseUrl();
              const resp = await fetch(`${base}/api/session/${currentSessionId}`);
              const { session } = await resp.json();
              if (session && session.status === 'ready' && session.previewUrl) {
                handleReady2({ previewUrl: session.previewUrl, terminalUrl: session.terminalUrl, ports: session.ports });
              }
            } catch (e) { /* ignore */ }
          }, 2000);
        }

        currentEventSource = await REPORUN_API.subscribeProgress(currentSessionId, {
          onStep: (data) => {
            updateStep(data.step, data.status, data.message);
            if (data.step === 'run' && data.status === 'done') scheduleReadyPoll2();
          },
          onBuildLog: (data) => {
            if (seenLogs2.has(data.message)) return;
            seenLogs2.add(data.message);
            appendLog(data.message, 'build');
          },
          onRunLog: (data) => {
            if (seenLogs2.has(data.message)) return;
            seenLogs2.add(data.message);
            appendLog(data.message, 'run');
            const msg = (data.message || '').toLowerCase();
            if (msg.includes('listening') || msg.includes('server running') ||
                msg.includes('started on') || msg.includes('ready on')) {
              scheduleReadyPoll2();
            }
          },
          onReady: (data) => handleReady2(data),
          onError: (data) => { if (!readyFired2) showError(mbody, 'Pipeline Error', data.message); },
        });
      } catch (err) {
        submitBtn.textContent = 'Continue →';
        submitBtn.disabled = false;
        showError(body, 'Failed to submit', err.message);
      }
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ── Error State ──
  // ─────────────────────────────────────────────────────────────────────────

  function showError(body, title, message) {
    body.innerHTML = `
      <div class="reporun-error">
        <div class="reporun-error-icon">
          <svg viewBox="0 0 24 24" width="48" height="48" fill="none">
            <circle cx="12" cy="12" r="11" stroke="#ef4444" stroke-width="2"/>
            <line x1="15" y1="9" x2="9" y2="15" stroke="#ef4444" stroke-width="2" stroke-linecap="round"/>
            <line x1="9" y1="9" x2="15" y2="15" stroke="#ef4444" stroke-width="2" stroke-linecap="round"/>
          </svg>
        </div>
        <h3 class="reporun-error-title">${title}</h3>
        <p class="reporun-error-message">${message}</p>
        <button class="reporun-action-btn reporun-action-secondary" onclick="document.getElementById('${MODAL_ID}').remove()">
          Close
        </button>
      </div>
    `;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ── Initialization ──
  // ─────────────────────────────────────────────────────────────────────────

  function init() {
    if (!getRepoInfo()) return;
    injectButton();
  }

  // Run on page load
  init();

  // Re-run on GitHub's SPA navigation (turbo:load, pjax)
  document.addEventListener('turbo:load', () => {
    isInjected = false;
    init();
  });

  // Also observe for dynamic DOM changes (GitHub uses pjax/turbo)
  const observer = new MutationObserver(() => {
    if (!isInjected && getRepoInfo()) {
      injectButton();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Cleanup on page unload
  window.addEventListener('beforeunload', () => {
    if (currentEventSource) currentEventSource.close();
    observer.disconnect();
  });
})();
