// === toast.js ===
// Toast notifications and rate-limit badge.
// globals: showToast, updateRateBadge

function updateRateBadge(rateUsed) {
    if (rateUsed == null) return; // intentional loose equality — catches both null and undefined
    const badge = document.querySelector('.rate-limit-badge');
    if (!badge) return;
    const val = parseInt(rateUsed, 10);
    if (isNaN(val)) return;
    // Build safely: SVG via innerHTML (static), text via textContent
    const svg = document.createElement('span');
    svg.innerHTML = '<svg class="icon" width="12" height="12"><use href="/static/img/icons.svg#icon-clock"></use></svg>';
    const text = document.createTextNode(' ' + val + '/150');
    badge.textContent = '';
    badge.appendChild(svg);
    badge.appendChild(text);
}

function showToast(message, isError = false) {
    // Legacy compat: map boolean to type string
    const type = isError === true ? 'error' : (typeof isError === 'string' ? isError : 'info');
    _showToast(message, type);
}

const TOAST_DELAY_ERROR_MS = 8000;
const TOAST_DELAY_INFO_MS = 4000;
const TOAST_DISMISS_ANIM_MS = 350;

function _showToast(message, type = 'info') {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        container.className = 'toast-container';
        container.setAttribute('aria-live', 'assertive');
        container.setAttribute('aria-relevant', 'additions');
        document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.setAttribute('role', 'alert');

    const span = document.createElement('span');
    span.textContent = message;
    toast.appendChild(span);

    const close = document.createElement('button');
    close.className = 'toast-close';
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '\u00D7';
    close.onclick = () => _dismissToast(toast);
    toast.appendChild(close);

    container.appendChild(toast);

    // Trigger reflow then animate in
    toast.offsetHeight;
    toast.classList.add('show');

    // Auto-dismiss: longer for errors/warnings
    const delay = (type === 'error' || type === 'warning') ? TOAST_DELAY_ERROR_MS : TOAST_DELAY_INFO_MS;
    toast._timeout = setTimeout(() => _dismissToast(toast), delay);
}

function _dismissToast(toast) {
    if (toast._dismissed) return;
    toast._dismissed = true;
    clearTimeout(toast._timeout);
    toast.classList.remove('show');
    toast.classList.add('exit');
    setTimeout(() => toast.remove(), TOAST_DISMISS_ANIM_MS);
}
