/**
 * RepoRun — Popup Script
 *
 * Manages the extension popup UI:
 * - Backend health check
 * - Active sessions list
 * - Settings persistence
 */

document.addEventListener('DOMContentLoaded', async () => {
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const sessionsList = document.getElementById('sessions-list');
  const sessionsEmpty = document.getElementById('sessions-empty');
  const backendUrlInput = document.getElementById('backend-url');
  const saveBtn = document.getElementById('save-settings');

  const dashboardLink = document.querySelector('.footer-link');

  // ── Load settings ──
  const settings = await new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, resolve);
  });
  backendUrlInput.value = settings.backendUrl || 'http://localhost:3333';
  if (dashboardLink) dashboardLink.href = `${backendUrlInput.value}/dashboard`;

  // ── Health check ──
  async function checkHealth() {
    const url = backendUrlInput.value.trim() || 'http://localhost:3333';
    try {
      const response = await fetch(`${url}/api/health`);
      const data = await response.json();

      statusDot.className = 'status-dot connected';
      statusText.textContent = 'Connected';
      statusText.style.color = '#22c55e';
      return true;
    } catch {
      statusDot.className = 'status-dot disconnected';
      statusText.textContent = 'Disconnected';
      statusText.style.color = '#ef4444';
      return false;
    }
  }

  await checkHealth();

  // ── Load sessions ──
  async function loadSessions() {
    const backendUrl = backendUrlInput.value.trim() || 'http://localhost:3333';

    try {
      const response = await fetch(`${backendUrl}/api/sessions`);
      const data = await response.json();
      const sessions = data.sessions || [];

      if (sessions.length === 0) {
        sessionsEmpty.style.display = 'flex';
        return;
      }

      sessionsEmpty.style.display = 'none';

      // Clear existing cards (but keep the empty state div)
      const existingCards = sessionsList.querySelectorAll('.session-card');
      existingCards.forEach(card => card.remove());

      sessions.forEach(session => {
        const card = createSessionCard(session);
        sessionsList.appendChild(card);
      });
    } catch {
      // Backend not available — show stored sessions
      const stored = await new Promise(resolve => {
        chrome.runtime.sendMessage({ type: 'GET_SESSIONS' }, resolve);
      });
      const sessions = stored.sessions || [];

      if (sessions.length === 0) {
        sessionsEmpty.style.display = 'flex';
        return;
      }

      sessionsEmpty.style.display = 'none';
      const existingCards = sessionsList.querySelectorAll('.session-card');
      existingCards.forEach(card => card.remove());

      sessions.forEach(session => {
        const card = createSessionCard(session);
        sessionsList.appendChild(card);
      });
    }
  }

  function createSessionCard(session) {
    const card = document.createElement('div');
    card.className = 'session-card';

    const statusClass = getStatusClass(session.status);
    const statusIcon = getStatusIcon(session.status);
    const timeAgo = getTimeAgo(session.createdAt || session.startedAt);

    card.innerHTML = `
      <div class="session-status-icon ${statusClass}">
        ${statusIcon}
      </div>
      <div class="session-info">
        <div class="session-repo">${session.owner || ''}/${session.repo || session.repoKey || ''}</div>
        <div class="session-meta">${session.status || 'unknown'} · ${timeAgo}</div>
      </div>
      <div class="session-actions">
        ${session.previewUrl ? `
          <a href="${session.previewUrl}" target="_blank" class="session-action-btn" title="Open Preview">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/>
              <polyline points="15 3 21 3 21 9"/>
              <line x1="10" y1="14" x2="21" y2="3"/>
            </svg>
          </a>
        ` : ''}
        <button class="session-action-btn stop-btn" data-session-id="${session.id}" title="Stop">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="6" y="6" width="12" height="12" rx="1"/>
          </svg>
        </button>
      </div>
    `;

    // Stop button handler
    const stopBtn = card.querySelector('.stop-btn');
    if (stopBtn) {
      stopBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const sid = stopBtn.dataset.sessionId;
        const backendUrl = backendUrlInput.value.trim() || 'http://localhost:3333';
        try {
          await fetch(`${backendUrl}/api/session/${sid}`, { method: 'DELETE' });
          card.remove();
          // Check if list is empty
          if (sessionsList.querySelectorAll('.session-card').length === 0) {
            sessionsEmpty.style.display = 'flex';
          }
        } catch (err) {
          console.error('[RepoRun] Failed to stop session:', err);
        }
      });
    }

    return card;
  }

  function getStatusClass(status) {
    if (['ready', 'running'].includes(status)) return 'running';
    if (['building', 'cloning', 'detecting', 'configuring', 'resuming'].includes(status)) return 'building';
    if (status === 'error') return 'error';
    if (status === 'waiting_for_input') return 'waiting';
    return '';
  }

  function getStatusIcon(status) {
    if (['ready', 'running'].includes(status)) {
      return '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z" fill="currentColor"/></svg>';
    }
    if (['building', 'cloning', 'detecting', 'configuring', 'resuming'].includes(status)) {
      return '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>';
    }
    if (status === 'error') {
      return '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    }
    if (status === 'waiting_for_input') {
      return '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';
    }
    return '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><circle cx="12" cy="12" r="4"/></svg>';
  }

  function getTimeAgo(dateStr) {
    if (!dateStr) return '';
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  await loadSessions();

  // ── Save settings ──
  saveBtn.addEventListener('click', () => {
    const url = backendUrlInput.value.trim();
    chrome.runtime.sendMessage({ type: 'SET_SETTINGS', backendUrl: url }, () => {
      saveBtn.classList.add('saved');
      setTimeout(() => saveBtn.classList.remove('saved'), 1500);
      if (dashboardLink) dashboardLink.href = `${url}/dashboard`;
      checkHealth();
      loadSessions();
    });
  });

  // ── Refresh every 10 seconds ──
  setInterval(() => {
    checkHealth();
    loadSessions();
  }, 10000);
});
