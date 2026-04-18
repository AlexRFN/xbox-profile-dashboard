// === tracking.js ===
// Game tracking: status pill cycling, star rating, save tracking form,
// per-game detail fetch, random backlog picker.
// globals: cycleStatus, setRating, saveTracking, fetchGameDetails, randomBacklogGame

const statusCycle = ['unset', 'backlog', 'playing', 'finished', 'dropped'];
const statusLabels = { unset: '—', backlog: 'Backlog', playing: 'Playing', finished: 'Finished', dropped: 'Dropped' };

async function updateStatus(titleId, status) {
    const resp = await fetch(`/api/game/${titleId}/tracking`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
}

// --- Cycle status via pill click ---
function cycleStatus(event, titleId, currentStatus) {
    event.stopPropagation();
    const idx = statusCycle.indexOf(currentStatus);
    const next = statusCycle[(idx + 1) % statusCycle.length];
    const btn = event.currentTarget;

    // Snapshot current state for rollback on failure
    const prevClass = btn.className;
    const prevText = btn.textContent;
    const prevOnclick = btn.getAttribute('onclick');

    // Optimistic update — bounce animation
    btn.className = `status-pill status-pill-${next} pill-bounce`;
    btn.textContent = statusLabels[next];
    btn.dataset.status = next;
    btn.setAttribute('onclick', `cycleStatus(event, '${titleId}', '${next}')`);
    btn.addEventListener('animationend', () => btn.classList.remove('pill-bounce'), { once: true });

    updateStatus(titleId, next)
        .then(() => showToast('Status updated'))
        .catch(() => {
            showToast('Failed to update status', true);
            // Rollback to previous visual state
            btn.className = prevClass;
            btn.textContent = prevText;
            btn.dataset.status = currentStatus;
            btn.setAttribute('onclick', prevOnclick);
        });
}

// --- Star rating ---
function setRating(value) {
    const container = document.getElementById('track-rating');
    if (!container) return;
    container.dataset.rating = value;
    container.querySelectorAll('.star').forEach(star => {
        const v = parseInt(star.dataset.value);
        const svg = star.querySelector('svg');
        if (v <= value) {
            star.classList.add('active');
            svg.setAttribute('fill', 'currentColor');
        } else {
            star.classList.remove('active');
            svg.setAttribute('fill', 'none');
        }
    });
    // Show/hide clear button
    let clearBtn = container.querySelector('.star-clear');
    if (value > 0 && !clearBtn) {
        clearBtn = document.createElement('button');
        clearBtn.type = 'button';
        clearBtn.className = 'star-clear';
        clearBtn.innerHTML = '\u00d7';
        clearBtn.title = 'Clear rating';
        clearBtn.onclick = () => setRating(0);
        container.appendChild(clearBtn);
    } else if (value === 0 && clearBtn) {
        clearBtn.remove();
    }
}

// --- Save tracking from game detail page ---
async function saveTracking(titleId) {
    const status = document.getElementById('track-status').value;
    const notes = document.getElementById('track-notes').value;
    const finishedDate = document.getElementById('track-finished').value;
    const ratingEl = document.getElementById('track-rating');
    const rating = ratingEl ? parseInt(ratingEl.dataset.rating) || null : null;

    try {
        const resp = await fetch(`/api/game/${titleId}/tracking`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                status,
                notes,
                finished_date: finishedDate || null,
                rating,
            }),
        });
        if (resp.ok) {
            showToast('Tracking saved');
        } else {
            showToast('Failed to save', true);
        }
    } catch (e) {
        showToast('Error: ' + e.message, true);
    }
}

// --- Fetch game details (stats + achievements) ---
async function fetchGameDetails(titleId) {
    const statusEl = document.getElementById('fetch-status');
    statusEl.textContent = 'Fetching...';

    try {
        const resp = await fetch(`/api/sync/game/${titleId}`, { method: 'POST' });
        const data = await resp.json();

        if (data.success) {
            showToast(data.message);
            updateRateBadge(data.rate_used);
            softRefresh(500);
        } else {
            statusEl.textContent = data.message;
            showToast(data.message, true);
        }
    } catch (e) {
        statusEl.textContent = 'Error: ' + e.message;
        showToast('Error: ' + e.message, true);
    }
}

// --- Random backlog game ---
async function randomBacklogGame() {
    try {
        const resp = await fetch('/api/random-backlog');
        const data = await resp.json();
        if (data.found) {
            startSpaNav('/game/' + data.title_id);
        } else {
            showToast('No backlog games found. Mark some games as "backlog" first.');
        }
    } catch (e) {
        showToast('Error: ' + e.message, true);
    }
}
