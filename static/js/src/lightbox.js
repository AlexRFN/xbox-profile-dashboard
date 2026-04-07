// === lightbox.js ===
// Screenshot lightbox: open/close, prev/next navigation, keyboard shortcuts,
// fullscreen with auto-hide controls, download.
// globals: openLightboxFromCard, openLightboxAt, closeLightbox, closeLightboxOutside,
//          lightboxPrev, lightboxNext, updateLightboxArrows, downloadLightboxCapture,
//          lightboxFullscreen
// sets: _lightboxDirty (read by captures.js htmx swap handlers and captures view toggle)

let _lightboxItems = [];
let _lightboxIndex = 0;
let _lightboxDirty = true;
let _lightboxPreload = null;

function _cancelLightboxPreload() {
    if (!_lightboxPreload) return;
    _lightboxPreload.onload = _lightboxPreload.onerror = null;
    _lightboxPreload.src = '';
    _lightboxPreload = null;
}

function _buildLightboxItems() {
    const cards = Array.from(document.querySelectorAll('.capture-card[data-content-id]'));
    _lightboxItems = cards.map(c => ({
        contentId: c.dataset.contentId,
        game: c.dataset.game,
        date: c.dataset.date,
        res: c.dataset.res,
        full: c.dataset.full,
        thumb: c.dataset.thumb,
        size: parseInt(c.dataset.size) || 0,
    }));
    _lightboxDirty = false;
    return cards;
}

function openLightboxFromCard(card) {
    if (_selectMode) { toggleCaptureCard(card); return; }
    // Rebuild items list only if dirty (htmx swap or first open)
    const cards = _lightboxDirty ? _buildLightboxItems()
        : Array.from(document.querySelectorAll('.capture-card[data-content-id]'));
    const idx = cards.indexOf(card);
    if (idx >= 0) openLightboxAt(idx);
}

function _formatFileSize(bytes) {
    if (!bytes || bytes === 0) return '';
    if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
    if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return bytes + ' B';
}

function _formatDateTime(isoStr) {
    if (!isoStr) return '';
    try {
        const dt = new Date(isoStr);
        return dt.toLocaleDateString() + ' ' + dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (e) { return isoStr; }
}

function openLightboxAt(index) {
    _lightboxIndex = index;
    const item = _lightboxItems[index];
    if (!item) return;

    const lb = document.getElementById('lightbox');
    const img = document.getElementById('lightbox-img');
    const loading = document.getElementById('lightbox-loading');
    const gameEl = document.getElementById('lightbox-game');
    const dateEl = document.getElementById('lightbox-date');
    const resEl = document.getElementById('lightbox-res');
    const sizeEl = document.getElementById('lightbox-size');
    const sizeSep = document.getElementById('lightbox-size-sep');
    const dlBtn = document.getElementById('lightbox-download');

    _cancelLightboxPreload();

    const fullUrl = item.full || item.thumb || '';
    const thumbUrl = item.thumb || '';
    if (!fullUrl && !thumbUrl) { img.style.opacity = '0'; if (loading) loading.style.display = 'none'; return; }

    img.style.opacity = '0';
    img.style.display = '';
    if (loading) loading.style.display = 'flex';

    // Simple Image preload: try full-res first, fall back to thumbnail
    const preload = new Image();
    _lightboxPreload = preload;
    preload.onload = () => {
        if (_lightboxPreload !== preload) return; // stale
        img.src = preload.src;
        img.style.opacity = '1';
        if (loading) loading.style.display = 'none';
    };
    preload.onerror = () => {
        if (_lightboxPreload !== preload) return; // stale
        if (preload.src !== thumbUrl && thumbUrl) {
            preload.src = thumbUrl;
        } else {
            img.src = fullUrl;
            img.style.opacity = '1';
            if (loading) loading.style.display = 'none';
        }
    };
    preload.src = fullUrl;

    // Metadata
    gameEl.textContent = item.game || '';
    dateEl.textContent = _formatDateTime(item.date);
    resEl.textContent = item.res || '';
    const sizeStr = _formatFileSize(item.size);
    if (sizeEl) sizeEl.textContent = sizeStr;
    if (sizeSep) sizeSep.style.display = sizeStr ? '' : 'none';

    // Store download info for blob download
    if (dlBtn) {
        dlBtn.dataset.url = fullUrl;
        dlBtn.dataset.filename = _captureFilename(item.game, item.date);
    }

    lb.classList.add('active');
    document.body.style.overflow = 'hidden';
    updateLightboxArrows();
}

function closeLightbox() {
    const lb = document.getElementById('lightbox');
    if (!lb) return;
    clearTimeout(_fsHideTimer);
    _cancelLightboxPreload();
    // Exit fullscreen if active
    if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
    }
    lb.classList.remove('active');
    document.body.style.overflow = '';
}

function closeLightboxOutside(event) {
    // Close only when clicking the backdrop or the content area (not the image itself)
    if (event.target.id === 'lightbox' || event.target.classList.contains('lightbox-content')) {
        closeLightbox();
    }
}

function lightboxPrev() {
    if (_lightboxIndex > 0) openLightboxAt(_lightboxIndex - 1);
}

function lightboxNext() {
    if (_lightboxIndex < _lightboxItems.length - 1) openLightboxAt(_lightboxIndex + 1);
}

function updateLightboxArrows() {
    const prev = document.getElementById('lightbox-prev');
    const next = document.getElementById('lightbox-next');
    const hidePrev = _lightboxIndex <= 0;
    const hideNext = _lightboxIndex >= _lightboxItems.length - 1;
    if (prev) { prev.style.opacity = hidePrev ? '0' : ''; prev.style.pointerEvents = hidePrev ? 'none' : ''; }
    if (next) { next.style.opacity = hideNext ? '0' : ''; next.style.pointerEvents = hideNext ? 'none' : ''; }
}

function downloadLightboxCapture() {
    const dlBtn = document.getElementById('lightbox-download');
    if (!dlBtn || !dlBtn.dataset.url) return;
    _downloadCapture(dlBtn.dataset.url, dlBtn.dataset.filename);
}

let _fsHideTimer = null;

function lightboxFullscreen() {
    const lb = document.getElementById('lightbox');
    if (!lb) return;
    if (document.fullscreenElement) {
        document.exitFullscreen();
    } else {
        lb.requestFullscreen().catch(() => {});
    }
}

// Auto-hide controls in fullscreen after 2s of inactivity
function _fsShowControls() {
    const lb = document.getElementById('lightbox');
    if (!lb || !document.fullscreenElement) return;
    lb.classList.remove('controls-hidden');
    document.body.style.cursor = '';
    clearTimeout(_fsHideTimer);
    _fsHideTimer = setTimeout(() => {
        if (document.fullscreenElement) {
            lb.classList.add('controls-hidden');
            document.body.style.cursor = 'none';
        }
    }, 2000);
}

function _fsMouseMove() { _fsShowControls(); }

document.addEventListener('fullscreenchange', () => {
    const lb = document.getElementById('lightbox');
    if (!lb) return;
    if (document.fullscreenElement) {
        document.addEventListener('mousemove', _fsMouseMove, { passive: true });
        _fsShowControls();
    } else {
        document.removeEventListener('mousemove', _fsMouseMove);
        lb.classList.remove('controls-hidden');
        document.body.style.cursor = '';
        clearTimeout(_fsHideTimer);
    }
});

// Keyboard navigation for lightbox + select mode
document.addEventListener('keydown', (e) => {
    const lb = document.getElementById('lightbox');
    if (lb && lb.classList.contains('active')) {
        if (e.key === 'Escape') { e.preventDefault(); closeLightbox(); }
        if (e.key === 'ArrowLeft') lightboxPrev();
        if (e.key === 'ArrowRight') lightboxNext();
        if (e.key === 'f' || e.key === 'F') lightboxFullscreen();
        return;
    }
    if (e.key === 'Escape' && _selectMode) { e.preventDefault(); toggleSelectMode(); }
});
