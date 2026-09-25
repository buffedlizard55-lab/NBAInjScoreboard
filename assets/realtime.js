/**
 * Real-time injury alert poller for new backend
 * Polls /api/alerts every 2 seconds (as per spec)
 * Works with both same-origin and Render backend via localStorage override
 */

const POLL_INTERVAL = 2000;
let pollTimer = null;
let lastAlerts = [];
let backendUrl = null;

function getBackendBase() {
  // Allow override via localStorage for GitHub Pages -> Render
  // e.g., localStorage.setItem('INJURY_API_BASE', 'https://your-backend.onrender.com')
  const override = localStorage.getItem('INJURY_API_BASE');
  if (override) {
    try {
      const u = new URL(override);
      if (u.protocol === 'https:') return u.origin;
    } catch {}
  }
  // If on GitHub Pages, try to use same origin first, fallback to Render if configured via meta tag
  const meta = document.querySelector('meta[name=\"injury-api-base\"]');
  if (meta) {
    const content = meta.getAttribute('content');
    if (content) {
      try {
        const u = new URL(content);
        if (u.protocol === 'https:') return u.origin;
      } catch {}
    }
  }
  return ''; // same origin
}

async function fetchAlerts() {
  const base = getBackendBase();
  const params = new URLSearchParams();
  // Try to preserve sport filter from page
  const sport = document.body.dataset.sport || new URLSearchParams(location.search).get('sport');
  const team = new URLSearchParams(location.search).get('team');
  if (sport) params.set('sport', sport);
  if (team) params.set('team', team);
  params.set('limit', '50');

  const url = `${base}/api/alerts?${params.toString()}`;
  try {
    const res = await fetch(url, { cache: 'no-store', headers: { 'Accept': 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data.alerts)) throw new Error('Invalid alerts response');
    return data;
  } catch (e) {
    console.warn(`[Realtime] Fetch ${url} failed: ${e.message}`);
    return null;
  }
}

function renderRealTimeAlerts(data) {
  if (!data) return;
  const alerts = data.alerts || [];
  // Only update if changed
  const ids = alerts.map(a => a.id || `${a.game_id}:${a.player_name}:${a.status}`).join('|');
  const lastIds = lastAlerts.map(a => a.id || `${a.game_id}:${a.player_name}:${a.status}`).join('|');
  if (ids === lastIds) return;
  lastAlerts = alerts;

  // Update health panel with collector status if present
  const modeLabel = document.getElementById('mode-label');
  if (modeLabel && data.collectors) {
    const active = data.game_window?.count || 0;
    const collectorNames = Object.keys(data.collectors).join(', ');
    modeLabel.textContent = `Real-time backend · ${active} active games · ${collectorNames}`;
    modeLabel.className = 'connection good';
  }

  // If on alerts page, render into alerts-feed if new backend format
  const feed = document.getElementById('alerts-feed');
  if (feed && document.body.dataset.page === 'alerts') {
    // Only render if using new backend (check if old snapshot not present)
    // For new backend, alerts have different shape than old engine
    if (alerts.length > 0 && alerts[0].source && ['play-by-play', 'bluesky', 'google-news', 'mastodon'].includes(alerts[0].source)) {
      feed.replaceChildren();
      for (const alert of alerts.slice(0, 20)) {
        const card = document.createElement('article');
        card.className = 'alert-card injury';
        const aside = document.createElement('div');
        aside.className = 'alert-aside';
        const teamEl = document.createElement('strong');
        teamEl.textContent = alert.team || 'UNK';
        const timeEl = document.createElement('span');
        try {
          timeEl.textContent = new Date(alert.timestamp_source).toLocaleTimeString();
        } catch {
          timeEl.textContent = alert.timestamp_source || '';
        }
        aside.append(teamEl, timeEl);

        const body = document.createElement('div');
        body.className = 'alert-body';
        const pill = document.createElement('span');
        pill.className = `status-pill ${alert.status.toLowerCase()}`;
        pill.textContent = alert.status.replace(/_/g, ' ');
        const h3 = document.createElement('h3');
        h3.textContent = alert.player_name;
        const caption = document.createElement('span');
        caption.className = 'team-caption';
        caption.textContent = `${alert.sport?.toUpperCase()} · ${alert.team} · ${alert.source} ${alert.verified ? '✓' : ''} · latency ${alert.latency_ms}ms`;
        const p = document.createElement('p');
        p.textContent = alert.verbatim_text;
        const proof = document.createElement('div');
        proof.className = 'proof';
        proof.textContent = `Source: ${alert.source_url || ''} · Observed ${alert.timestamp_first_seen}`;
        if (alert.source_url) {
          const a = document.createElement('a');
          a.href = alert.source_url;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.textContent = 'Source ↗';
          proof.append(document.createElement('br'), a);
        }
        body.append(pill, h3, caption, p, proof);
        card.append(aside, body);
        feed.append(card);
      }
    }
  }

  // Dispatch event for other scripts
  window.dispatchEvent(new CustomEvent('injury-alerts', { detail: data }));
}

export function startRealTimePolling() {
  if (pollTimer) return;
  console.log('[Realtime] Starting 2s polling for /api/alerts');
  // Initial fetch
  fetchAlerts().then(renderRealTimeAlerts);
  pollTimer = setInterval(async () => {
    const data = await fetchAlerts();
    renderRealTimeAlerts(data);
  }, POLL_INTERVAL);
}

export function stopRealTimePolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// Auto-start if on alerts or index page and backend is available
if (typeof window !== 'undefined') {
  const page = document.body?.dataset?.page;
  if (page === 'alerts' || page === 'home') {
    // Wait for DOM ready
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        // Try to detect new backend via /api/health
        fetch(`${getBackendBase()}/api/health`, { cache: 'no-store' })
          .then(r => r.ok ? r.json() : null)
          .then(data => {
            if (data && data.service === 'nfl-nba-injury-alert-backend') {
              console.log('[Realtime] New backend detected, starting 2s polling');
              startRealTimePolling();
            }
          })
          .catch(() => {});
      });
    } else {
      fetch(`${getBackendBase()}/api/health`, { cache: 'no-store' })
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          if (data && data.service === 'nfl-nba-injury-alert-backend') {
            startRealTimePolling();
          }
        })
        .catch(() => {});
    }
  }
}
