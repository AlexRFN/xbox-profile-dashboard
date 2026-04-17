// === cmd-palette.js ===
// Command palette (Ctrl+K) with MiniSearch game index,
// keyboard shortcuts overlay, global hotkeys.
// globals: openCmdPalette, closeCmdPalette, renderCmdResults,
//          openShortcuts, closeShortcuts, initCmdPalette, initHotkeys

const CMD_NAV = [
    { name: 'Profile',      sub: 'Your gaming stats',          href: '/',             icon: '◈' },
    { name: 'Library',      sub: 'All your games',             href: '/library',      icon: '▤' },
    { name: 'Achievements', sub: 'Recent & rare achievements', href: '/achievements', icon: '★' },
    { name: 'Timeline',     sub: 'Your gaming journey',        href: '/timeline',     icon: '↕' },
    { name: 'Captures',     sub: 'Screenshots & clips',        href: '/captures',     icon: '⊡' },
    { name: 'Friends',      sub: 'Online now & friends list',  href: '/friends',      icon: '◎' },
];

let _cmdOpen = false;
let _cmdActive = -1;
let _cmdItems = [];
let _cmdSearchTimer = null;
let _miniSearch = null;
let _miniSearchLoading = false;

const _MS_OPTS = {
    fields: ['name'],
    storeFields: ['name', 'title_id', 'display_image', 'progress_percentage', 'status'],
    searchOptions: { fuzzy: 0.2, prefix: true },
};

async function _buildIndexInWorker() {
    return new Promise((resolve, reject) => {
        const worker = new Worker('/static/js/minisearch.worker.js');
        worker.onmessage = (e) => {
            worker.terminate();
            if (e.data.type === 'ready') resolve(e.data.json);
            else reject(new Error(e.data.message || 'worker error'));
        };
        worker.onerror = (err) => { worker.terminate(); reject(err); };
        worker.postMessage({ type: 'build', url: '/api/games/index' });
    });
}

async function _buildIndexOnMain() {
    const res = await fetch('/api/games/index');
    const games = await res.json();
    const index = new MiniSearch(_MS_OPTS);
    index.addAll(games.map((g, i) => ({ id: i, ...g })));
    return index;
}

async function _ensureGameIndex() {
    if (_miniSearch || _miniSearchLoading) return;
    if (typeof MiniSearch === 'undefined') return;
    _miniSearchLoading = true;
    try {
        if (typeof Worker !== 'undefined') {
            const json = await _buildIndexInWorker();
            _miniSearch = MiniSearch.loadJSON(json, _MS_OPTS);
        } else {
            _miniSearch = await _buildIndexOnMain();
        }
    } catch (_) {
        // Worker path failed — try main-thread fallback once, then give up silently.
        try { _miniSearch = await _buildIndexOnMain(); } catch (__) { /* server-side search remains */ }
    } finally {
        _miniSearchLoading = false;
    }
}

function _invalidateGameIndex() { _miniSearch = null; }

function _escHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const _STATUS_LABELS = { playing: 'Playing', backlog: 'Backlog', finished: 'Finished', dropped: 'Dropped' };

function openCmdPalette() {
    const el = document.getElementById('cmd-palette');
    const input = document.getElementById('cmd-input');
    if (!el || !input) return;
    _cmdOpen = true;
    _cmdActive = -1;
    el.style.display = 'flex';
    if (window.invalidateGlassRects) window.invalidateGlassRects();
    requestAnimationFrame(() => {
        input.value = '';
        input.focus();
        renderCmdResults('');
    });
    document.body.style.overflow = 'hidden';
    _ensureGameIndex();
}

function closeCmdPalette() {
    const el = document.getElementById('cmd-palette');
    if (!el) return;
    _cmdOpen = false;
    el.style.display = 'none';
    if (window.invalidateGlassRects) window.invalidateGlassRects();
    document.body.style.overflow = '';
}

function renderCmdResults(query) {
    const container = document.getElementById('cmd-results');
    if (!container) return;

    const q = query.trim().toLowerCase();
    let html = '';
    const items = [];

    if (!q) {
        html += '<div class="cmd-section-label">Navigation</div>';
        CMD_NAV.forEach((item, i) => {
            const active = i === _cmdActive ? ' active' : '';
            html += `<a href="${item.href}" class="cmd-item${active}" data-cmd-idx="${i}">
                <div class="cmd-item-icon">${item.icon}</div>
                <div class="cmd-item-text">
                    <div class="cmd-item-name">${item.name}</div>
                    <div class="cmd-item-sub">${item.sub}</div>
                </div>
                <span class="cmd-item-arrow">→</span>
            </a>`;
            items.push({ href: item.href });
        });
    } else {
        // Nav matches
        const navMatches = CMD_NAV.filter(n => n.name.toLowerCase().includes(q));
        if (navMatches.length) {
            html += '<div class="cmd-section-label">Navigation</div>';
            navMatches.forEach(item => {
                const idx = items.length;
                const active = idx === _cmdActive ? ' active' : '';
                html += `<a href="${item.href}" class="cmd-item${active}" data-cmd-idx="${idx}">
                    <div class="cmd-item-icon">${item.icon}</div>
                    <div class="cmd-item-text">
                        <div class="cmd-item-name">${item.name}</div>
                        <div class="cmd-item-sub">${item.sub}</div>
                    </div>
                    <span class="cmd-item-arrow">→</span>
                </a>`;
                items.push({ href: item.href });
            });
        }

        // MiniSearch game results
        if (_miniSearch) {
            const results = _miniSearch.search(query.trim(), { limit: 8 });
            if (results.length) {
                html += '<div class="cmd-section-label">Games</div>';
                results.forEach(r => {
                    const idx = items.length;
                    const active = idx === _cmdActive ? ' active' : '';
                    const img = r.display_image
                        ? `<img src="${_escHtml(r.display_image)}" alt="" width="32" height="32" style="border-radius:4px;object-fit:cover" loading="lazy">`
                        : '<div style="width:32px;height:32px;border-radius:4px;background:var(--surface-card)"></div>';
                    const pct = r.progress_percentage || 0;
                    const status = _STATUS_LABELS[r.status] || '';
                    const sub = [pct + '%', status].filter(Boolean).join(' · ');
                    html += `<a href="/game/${_escHtml(r.title_id)}" class="cmd-item${active}" data-cmd-idx="${idx}">
                        <div class="cmd-item-icon cmd-item-thumb">${img}</div>
                        <div class="cmd-item-text">
                            <div class="cmd-item-name">${_escHtml(r.name)}</div>
                            <div class="cmd-item-sub">${_escHtml(sub)}</div>
                        </div>
                        <span class="cmd-item-arrow">→</span>
                    </a>`;
                    items.push({ href: `/game/${r.title_id}` });
                });
            }
        }

        // Fallback: search library server-side
        const searchHref = `/library?q=${encodeURIComponent(query.trim())}`;
        const idx = items.length;
        const active = idx === _cmdActive ? ' active' : '';
        html += '<div class="cmd-section-label">Search Library</div>';
        html += `<a href="${searchHref}" class="cmd-item${active}" data-cmd-idx="${idx}">
            <div class="cmd-item-icon">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
            </div>
            <div class="cmd-item-text">
                <div class="cmd-item-name">Search for "<strong>${_escHtml(query.trim())}</strong>"</div>
                <div class="cmd-item-sub">Full library search with filters</div>
            </div>
            <span class="cmd-item-arrow">→</span>
        </a>`;
        items.push({ href: searchHref });
    }

    _cmdItems = items;
    container.innerHTML = html || '<div class="cmd-empty">No results</div>';
}

function _cmdNavigate() {
    if (_cmdActive >= 0 && _cmdItems[_cmdActive]) {
        closeCmdPalette();
        startFullNav(_cmdItems[_cmdActive].href);
    }
}

let _cmdPaletteInit = false;
function initCmdPalette() {
    if (_cmdPaletteInit) return;
    const input = document.getElementById('cmd-input');
    if (!input) return;
    _cmdPaletteInit = true;

    input.addEventListener('input', () => {
        clearTimeout(_cmdSearchTimer);
        _cmdActive = -1;
        _cmdSearchTimer = setTimeout(() => renderCmdResults(input.value), 120);
    });

    input.addEventListener('keydown', (e) => {
        const count = _cmdItems.length;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            const container = document.getElementById('cmd-results');
            const prev = container?.querySelector('.cmd-item.active');
            _cmdActive = (_cmdActive + 1) % count;
            if (prev) prev.classList.remove('active');
            const next = container?.querySelector('[data-cmd-idx="' + _cmdActive + '"]');
            if (next) { next.classList.add('active'); next.scrollIntoView({ block: 'nearest' }); }
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            const container = document.getElementById('cmd-results');
            const prev = container?.querySelector('.cmd-item.active');
            _cmdActive = (_cmdActive - 1 + count) % count;
            if (prev) prev.classList.remove('active');
            const next = container?.querySelector('[data-cmd-idx="' + _cmdActive + '"]');
            if (next) { next.classList.add('active'); next.scrollIntoView({ block: 'nearest' }); }
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (_cmdActive >= 0) {
                _cmdNavigate();
            } else if (input.value.trim()) {
                closeCmdPalette();
                startFullNav(`/library?q=${encodeURIComponent(input.value.trim())}`);
            }
        }
    });

    // Click on results
    document.getElementById('cmd-results')?.addEventListener('click', (e) => {
        const item = e.target.closest('.cmd-item');
        if (item) closeCmdPalette();
    });
}

// --- Keyboard Shortcuts Overlay ---
let _shortcutsOpen = false;

function openShortcuts() {
    const el = document.getElementById('shortcuts-overlay');
    if (!el) return;
    _shortcutsOpen = true;
    el.style.display = 'flex';
    if (window.invalidateGlassRects) window.invalidateGlassRects();
    document.body.style.overflow = 'hidden';
}

function closeShortcuts() {
    const el = document.getElementById('shortcuts-overlay');
    if (!el) return;
    _shortcutsOpen = false;
    el.style.display = 'none';
    if (window.invalidateGlassRects) window.invalidateGlassRects();
    document.body.style.overflow = '';
}

// --- Global keyboard shortcuts (hotkeys-js) ---
function initHotkeys() {
    if (typeof hotkeys === 'undefined') return;

    // Allow hotkeys to fire even when focus is in input/textarea/select
    // (we handle scoping per-binding below)
    hotkeys.filter = function () { return true; };

    // Ctrl+K / Cmd+K — Command palette (always, even in inputs)
    hotkeys('ctrl+k, command+k', (e) => {
        e.preventDefault();
        if (_cmdOpen) closeCmdPalette(); else openCmdPalette();
    });

    // Ctrl+Shift+S — Sync library (always)
    hotkeys('ctrl+shift+s, command+shift+s', (e) => {
        e.preventDefault();
        if (typeof syncAll === 'function') syncAll();
    });

    // Escape — close overlays (always)
    hotkeys('escape', (e) => {
        if (_cmdOpen) { e.preventDefault(); closeCmdPalette(); return; }
        if (_shortcutsOpen) { e.preventDefault(); closeShortcuts(); return; }
    });

    // / — Focus library search (not in inputs)
    hotkeys('/', (e) => {
        if (_isInInput()) return;
        const search = document.querySelector('.library-filter-input[name="q"]');
        if (search) { e.preventDefault(); search.focus(); }
    });

    // ? — Show keyboard shortcuts (not in inputs)
    hotkeys('shift+/', (e) => {
        if (_isInInput()) return;
        e.preventDefault();
        if (_shortcutsOpen) closeShortcuts(); else openShortcuts();
    });

    // Focus trap for command palette Tab key
    hotkeys('tab, shift+tab', (e) => {
        if (!_cmdOpen) return;
        const panel = document.querySelector('.cmd-panel');
        if (!panel) return;
        const focusable = panel.querySelectorAll('input, a[href], button, [tabindex]:not([tabindex="-1"])');
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
            e.preventDefault(); last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault(); first.focus();
        }
    });
}

function _isInInput() {
    const tag = document.activeElement?.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || document.activeElement?.isContentEditable;
}
