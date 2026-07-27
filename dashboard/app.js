/**
 * RepoRun Dashboard — Application Logic
 *
 * Fetches sessions from the API, renders them in a grid,
 * handles session detail views with live preview and xterm.js terminal.
 */

(() => {
  'use strict';

  const API_BASE = window.location.origin;

  // ── DOM refs ──
  const serverDot = document.getElementById('server-dot');
  const serverText = document.getElementById('server-text');
  const statSessions = document.getElementById('stat-sessions');
  const statCache = document.getElementById('stat-cache');
  const sessionsGrid = document.getElementById('sessions-grid');
  const emptyState = document.getElementById('empty-state');
  const sessionsSection = document.getElementById('sessions-section');
  const detailPanel = document.getElementById('detail-panel');
  const refreshBtn = document.getElementById('refresh-btn');

  // Detail panel
  const backBtn = document.getElementById('back-btn');
  const detailRepo = document.getElementById('detail-repo');
  const detailStatus = document.getElementById('detail-status');
  const detailPort = document.getElementById('detail-port');
  const detailUrl = document.getElementById('detail-url');
  const detailCreated = document.getElementById('detail-created');
  const detailPreviewBtn = document.getElementById('detail-preview-btn');
  const detailStopBtn = document.getElementById('detail-stop-btn');
  const previewContainer = document.getElementById('preview-container');
  const previewFrame = document.getElementById('preview-frame');
  const previewReload = document.getElementById('preview-reload');
  const terminalContainer = document.getElementById('terminal-container');
  const terminalEl = document.getElementById('terminal');
  const terminalStatus = document.getElementById('terminal-status');

  let currentTerm = null;
  let currentWs = null;
  let selectedSessionId = null;

  // ─────────────────────────────────────────────────────────────────────
  // ── API Calls ──
  // ─────────────────────────────────────────────────────────────────────

  async function api(endpoint, options = {}) {
    const res = await fetch(`${API_BASE}${endpoint}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    if (!res.ok) throw new Error(`API ${res.status}`);
    return res.json();
  }

  async function checkHealth() {
    try {
      await api('/api/health');
      serverDot.className = 'server-dot connected';
      serverText.textContent = 'Connected';
      return true;
    } catch {
      serverDot.className = 'server-dot disconnected';
      serverText.textContent = 'Disconnected';
      return false;
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // ── Sessions List ──
  // ─────────────────────────────────────────────────────────────────────

  async function loadSessions() {
    try {
      const data = await api('/api/sessions');
      const sessions = data.sessions || [];

      // Update stats
      statSessions.querySelector('.stat-value').textContent = sessions.length;

      if (sessions.length === 0) {
        emptyState.style.display = 'flex';
        sessionsGrid.style.display = 'none';
        return;
      }

      emptyState.style.display = 'none';
      sessionsGrid.style.display = 'grid';
      sessionsGrid.innerHTML = '';

      sessions.forEach(session => {
        sessionsGrid.appendChild(createSessionCard(session));
      });
    } catch {
      // API not available
    }
  }

  function createSessionCard(session) {
    const card = document.createElement('div');
    card.className = 'session-card';
    card.dataset.sessionId = session.id;

    const badgeClass = getBadgeClass(session.status);
    const timeStr = formatTime(session.createdAt);

    card.innerHTML = `
      <div class="session-card-header">
        <span class="session-card-repo">${session.repoKey || `${session.owner}/${session.repo}`}</span>
        <span class="session-card-badge ${badgeClass}">${session.status}</span>
      </div>
      <div class="session-card-meta">
        <span class="session-card-meta-item">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/>
            <polyline points="12 6 12 12 16 14"/>
          </svg>
          ${timeStr}
        </span>
        ${session.ports ? `
          <span class="session-card-meta-item">
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="2" y="2" width="20" height="20" rx="5"/>
              <line x1="2" y1="12" x2="22" y2="12"/>
            </svg>
            Port ${session.ports.host}
          </span>
        ` : ''}
      </div>
      <div class="session-card-actions">
        ${session.previewUrl ? `
          <a class="btn-action btn-primary" href="${session.previewUrl}" target="_blank" onclick="event.stopPropagation()">
            Open Preview
          </a>
        ` : ''}
        <button class="btn-action btn-danger session-stop-btn" data-sid="${session.id}" onclick="event.stopPropagation()">
          Stop
        </button>
      </div>
    `;

    // Click → open detail
    card.addEventListener('click', () => openDetail(session));

    // Stop button
    const stopBtn = card.querySelector('.session-stop-btn');
    stopBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      stopBtn.textContent = 'Stopping…';
      stopBtn.disabled = true;
      try {
        await api(`/api/session/${session.id}`, { method: 'DELETE' });
        card.remove();
        if (sessionsGrid.children.length === 0) {
          emptyState.style.display = 'flex';
          sessionsGrid.style.display = 'none';
        }
        updateStats();
      } catch {
        stopBtn.textContent = 'Stop';
        stopBtn.disabled = false;
      }
    });

    return card;
  }

  function getBadgeClass(status) {
    if (['ready', 'running'].includes(status)) return 'ready';
    if (['building', 'cloning', 'detecting', 'configuring', 'resuming'].includes(status)) return 'building';
    if (status === 'error') return 'error';
    if (status === 'waiting_for_input') return 'waiting';
    return '';
  }

  function formatTime(dateStr) {
    if (!dateStr) return '—';
    const d = new Date(dateStr);
    const diff = Date.now() - d.getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return d.toLocaleDateString();
  }

  function updateStats() {
    const count = sessionsGrid.querySelectorAll('.session-card').length;
    statSessions.querySelector('.stat-value').textContent = count;
  }

  // ─────────────────────────────────────────────────────────────────────
  // ── Detail Panel ──
  // ─────────────────────────────────────────────────────────────────────

  function openDetail(session) {
    selectedSessionId = session.id;
    sessionsSection.style.display = 'none';
    detailPanel.style.display = 'block';

    detailRepo.textContent = session.repoKey || `${session.owner}/${session.repo}`;
    detailStatus.textContent = session.status || '—';
    detailPort.textContent = session.ports ? session.ports.host : '—';
    detailCreated.textContent = session.createdAt ? new Date(session.createdAt).toLocaleString() : '—';

    if (session.previewUrl) {
      detailUrl.textContent = session.previewUrl;
      detailUrl.href = session.previewUrl;
      detailPreviewBtn.href = session.previewUrl;
      detailPreviewBtn.style.display = 'inline-flex';

      previewContainer.style.display = 'block';
      previewFrame.src = session.previewUrl;
    } else {
      detailUrl.textContent = '—';
      detailPreviewBtn.style.display = 'none';
      previewContainer.style.display = 'none';
    }

    // Setup terminal
    setupTerminal(session);
  }

  function closeDetail() {
    selectedSessionId = null;
    sessionsSection.style.display = 'block';
    detailPanel.style.display = 'none';
    previewFrame.src = '';

    // Cleanup terminal
    if (currentWs) {
      currentWs.close();
      currentWs = null;
    }
    if (currentTerm) {
      currentTerm.dispose();
      currentTerm = null;
    }

    loadSessions();
  }

  // ─────────────────────────────────────────────────────────────────────
  // ── Terminal (xterm.js) ──
  // ─────────────────────────────────────────────────────────────────────

  function setupTerminal(session) {
    // Clear previous terminal
    if (currentTerm) {
      currentTerm.dispose();
      currentTerm = null;
    }
    if (currentWs) {
      currentWs.close();
      currentWs = null;
    }
    terminalEl.innerHTML = '';

    if (!session.containerId) {
      terminalStatus.textContent = 'No container';
      return;
    }

    // Initialize xterm
    currentTerm = new window.Terminal({
      theme: {
        background: '#1c1c22',
        foreground: '#e4e4e7',
        cursor: '#6366f1',
        cursorAccent: '#1c1c22',
        selection: 'rgba(99, 102, 241, 0.3)',
        black: '#09090b',
        red: '#ef4444',
        green: '#22c55e',
        yellow: '#f59e0b',
        blue: '#6366f1',
        magenta: '#a855f7',
        cyan: '#06b6d4',
        white: '#e4e4e7',
        brightBlack: '#71717a',
        brightRed: '#f87171',
        brightGreen: '#4ade80',
        brightYellow: '#fbbf24',
        brightBlue: '#818cf8',
        brightMagenta: '#c084fc',
        brightCyan: '#22d3ee',
        brightWhite: '#fafafa',
      },
      fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.4,
      cursorBlink: true,
      cursorStyle: 'bar',
    });

    const fitAddon = new window.FitAddon.FitAddon();
    currentTerm.loadAddon(fitAddon);
    currentTerm.open(terminalEl);
    fitAddon.fit();

    // Connect WebSocket
    const wsUrl = `ws://${window.location.hostname}:${window.location.port}/ws/terminal?sessionId=${session.id}`;
    terminalStatus.textContent = 'Connecting…';
    terminalStatus.className = 'terminal-status';

    try {
      currentWs = new WebSocket(wsUrl);

      currentWs.onopen = () => {
        terminalStatus.textContent = 'Connected';
        terminalStatus.className = 'terminal-status connected';
        currentTerm.write('\r\n\x1b[1;35m ▶ RepoRun Terminal \x1b[0m\r\n\r\n');
      };

      currentWs.onmessage = (event) => {
        currentTerm.write(event.data);
      };

      currentWs.onclose = () => {
        terminalStatus.textContent = 'Disconnected';
        terminalStatus.className = 'terminal-status';
        currentTerm.write('\r\n\x1b[31m[Terminal disconnected]\x1b[0m\r\n');
      };

      currentWs.onerror = () => {
        terminalStatus.textContent = 'Error';
        terminalStatus.className = 'terminal-status';
      };

      currentTerm.onData((data) => {
        if (currentWs && currentWs.readyState === WebSocket.OPEN) {
          currentWs.send(data);
        }
      });
    } catch {
      terminalStatus.textContent = 'Failed to connect';
    }

    // Resize handling
    window.addEventListener('resize', () => {
      if (currentTerm && fitAddon) {
        fitAddon.fit();
      }
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  // ── URL params — auto-open session from extension ──
  // ─────────────────────────────────────────────────────────────────────

  function checkUrlParams() {
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get('session');
    if (sessionId) {
      // Fetch this session and open detail
      api(`/api/session/${sessionId}`)
        .then(data => {
          if (data.session) {
            openDetail(data.session);
          }
        })
        .catch(() => {});
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // ── Event Listeners ──
  // ─────────────────────────────────────────────────────────────────────

  refreshBtn.addEventListener('click', () => {
    refreshBtn.classList.add('spinning');
    loadSessions().then(() => {
      setTimeout(() => refreshBtn.classList.remove('spinning'), 800);
    });
  });

  backBtn.addEventListener('click', closeDetail);

  detailStopBtn.addEventListener('click', async () => {
    if (!selectedSessionId) return;
    detailStopBtn.textContent = 'Stopping…';
    detailStopBtn.disabled = true;
    try {
      await api(`/api/session/${selectedSessionId}`, { method: 'DELETE' });
      closeDetail();
    } catch {
      detailStopBtn.textContent = 'Stop';
      detailStopBtn.disabled = false;
    }
  });

  if (previewReload) {
    previewReload.addEventListener('click', () => {
      if (previewFrame.src) {
        previewFrame.src = previewFrame.src;
      }
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  // ── Init ──
  // ─────────────────────────────────────────────────────────────────────

  async function init() {
    await checkHealth();
    await loadSessions();
    checkUrlParams();

    // Refresh every 15 seconds
    setInterval(() => {
      checkHealth();
      if (!selectedSessionId) loadSessions();
    }, 15000);
  }

  init();
})();
