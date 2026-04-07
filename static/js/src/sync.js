// === sync.js ===
// SSE stream reader, unified sync (syncAll), friends refresh.
// globals: syncAll, fetchFriends
// uses: _abortActiveStream, _activeStreamAbort (module-level state), _readSSEStream

// Active AbortController for any running SSE stream. Cancelled on new stream start or page unload.
let _activeStreamAbort = null;

function _abortActiveStream() {
    if (_activeStreamAbort) {
        _activeStreamAbort.abort();
        _activeStreamAbort = null;
    }
}

// Abort any active stream when the user navigates away.
window.addEventListener('pagehide', _abortActiveStream);

// Shared logic for POST-based SSE endpoints (bulk details, smart sync, captures sync).
// Calls onMessage(data) for each parsed SSE event; returns when stream ends.
// Pass signal from an AbortController to support cancellation.
async function _readSSEStream(url, onMessage, signal = null) {
    const resp = await fetch(url, { method: 'POST', signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                try { onMessage(JSON.parse(line.slice(6))); }
                catch (e) { /* ignore parse errors */ }
            }
        }
    } finally {
        reader.releaseLock();
    }
}

// --- Unified Sync (single button: library + friends + games + captures) ---
async function syncAll() {
    const btn = document.getElementById('sync-btn');
    const progress = document.getElementById('sync-progress');
    if (!btn) return;

    _abortActiveStream();
    _activeStreamAbort = new AbortController();

    btn.setAttribute('aria-busy', 'true');
    btn.textContent = 'Scanning...';
    btn.disabled = true;
    if (progress) progress.textContent = '';

    try {
        await _readSSEStream('/api/sync', (data) => {
            if (data.type === 'phase') {
                btn.textContent = data.message;
            } else if (data.type === 'progress') {
                if (data.phase === 'games') {
                    btn.textContent = `Updating ${data.done}/${data.total} games...`;
                    if (progress) progress.textContent = `${data.game} (${data.reason})`;
                } else if (data.phase === 'captures') {
                    btn.textContent = `Captures page ${data.page}...`;
                    if (progress) progress.textContent = `${data.fetched} screenshots`;
                }
            } else if (data.type === 'finished') {
                showToast(data.message);
                updateRateBadge(data.rate_used);
                if (progress) progress.textContent = '';
                _invalidateGameIndex();
                if ((data.games_updated || 0) > 0 || (data.screenshots_synced || 0) > 0) {
                    softRefresh(1000);
                }
            }
        }, _activeStreamAbort.signal);
    } catch (e) {
        if (e.name !== 'AbortError') showToast('Error: ' + e.message, true);
    } finally {
        _activeStreamAbort = null;
        btn.setAttribute('aria-busy', 'false');
        btn.textContent = 'Sync';
        btn.disabled = false;
        if (progress) progress.textContent = '';
    }
}

// --- Friends refresh ---
async function fetchFriends() {
    const btn = document.getElementById('sync-friends-btn');
    if (!btn) return;
    btn.setAttribute('aria-busy', 'true');
    btn.textContent = 'Loading...';
    try {
        const resp = await fetch('/api/friends/refresh', { method: 'POST' });
        const data = await resp.json();
        if (data.success) {
            showToast(data.message);
            updateRateBadge(data.rate_used);
            softRefresh(500);
        } else {
            showToast(data.message, true);
        }
    } catch (e) {
        showToast('Error: ' + e.message, true);
    } finally {
        btn.setAttribute('aria-busy', 'false');
        btn.textContent = 'Refresh';
    }
}
