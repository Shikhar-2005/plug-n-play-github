/**
 * RepoRun — Background Service Worker
 *
 * Handles extension lifecycle events, cross-script messaging,
 * and session tracking in chrome.storage.local.
 */

// ── Listen for messages from content script / popup ──
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'GET_SESSIONS':
      chrome.storage.local.get('sessions', (data) => {
        sendResponse({ sessions: data.sessions || [] });
      });
      return true; // async response

    case 'ADD_SESSION':
      chrome.storage.local.get('sessions', (data) => {
        const sessions = data.sessions || [];
        sessions.unshift(message.session);
        chrome.storage.local.set({ sessions: sessions.slice(0, 50) });
        sendResponse({ success: true });
      });
      return true;

    case 'REMOVE_SESSION':
      chrome.storage.local.get('sessions', (data) => {
        const sessions = (data.sessions || []).filter(s => s.id !== message.sessionId);
        chrome.storage.local.set({ sessions });
        sendResponse({ success: true });
      });
      return true;

    case 'GET_SETTINGS':
      chrome.storage.local.get(['backendUrl'], (data) => {
        sendResponse({
          backendUrl: data.backendUrl || 'http://localhost:3000',
        });
      });
      return true;

    case 'SET_SETTINGS':
      chrome.storage.local.set({
        backendUrl: message.backendUrl,
      }, () => {
        sendResponse({ success: true });
      });
      return true;

    case 'HEALTH_CHECK':
      fetch(`${message.backendUrl || 'http://localhost:3000'}/api/health`)
        .then(res => res.json())
        .then(data => sendResponse({ healthy: true, ...data }))
        .catch(err => sendResponse({ healthy: false, error: err.message }));
      return true;

    default:
      sendResponse({ error: 'Unknown message type' });
  }
});

// ── Badge & notification on session ready ──
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'SESSION_READY') {
    chrome.action.setBadgeText({ text: '✓' });
    chrome.action.setBadgeBackgroundColor({ color: '#22c55e' });

    // Clear badge after 5 seconds
    setTimeout(() => {
      chrome.action.setBadgeText({ text: '' });
    }, 5000);
  }
});

// ── Install / update ──
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    // Set default settings
    chrome.storage.local.set({
      backendUrl: 'http://localhost:3000',
      sessions: [],
    });
    console.log('[RepoRun] Extension installed');
  }
});
