// === charts.js ===
// Dashboard charts (Chart.js), count-up animation, ambient glow, confetti.
// globals: initDashboardCharts, animateCountUp, initAmbientGlow, fireCompletionConfetti

// --- Count-up animation for stat cards ---
function animateCountUp() {
    document.querySelectorAll('[data-countup]').forEach(el => {
        const text = el.textContent.trim();
        const match = text.match(/^[\d,]+/);
        if (!match) return;

        const target = parseInt(match[0].replace(/,/g, ''), 10);
        if (isNaN(target) || target === 0) return;

        const suffix = text.slice(match[0].length);
        const duration = 1200;
        const start = performance.now();

        function step(now) {
            const elapsed = now - start;
            const progress = Math.min(elapsed / duration, 1);
            const eased = 1 - Math.pow(1 - progress, 3);
            const current = Math.round(target * eased);
            el.textContent = current.toLocaleString() + suffix;
            if (progress < 1) requestAnimationFrame(step);
        }

        el.textContent = '0' + suffix;
        requestAnimationFrame(step);
    });
}

// --- Dashboard Charts ---

function _buildMonthLabels(monthlyStats) {
    return monthlyStats.map(m => {
        const [y, mo] = m.month.split('-');
        return new Date(y, parseInt(mo) - 1).toLocaleString('default', { month: 'short', year: '2-digit' });
    });
}

function _initCompletionChart(ctx, stats, textColor, xboxGreen, style) {
    if (!ctx || stats.zero_progress === undefined) return;
    const zeroColor = style.getPropertyValue('--text-tertiary').trim() || '#505366';
    new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: ['0%', '1-50%', '51-99%', '100%'],
            datasets: [{
                data: [stats.zero_progress, stats.low_progress, stats.high_progress, stats.completed_games],
                backgroundColor: [zeroColor, '#f59e0b', '#3b82f6', xboxGreen],
            }]
        },
        options: {
            responsive: true,
            plugins: { legend: { position: 'bottom', labels: { color: textColor } } },
        },
    });
}

function _initGamerscoreChart(ctx, monthLabels, stats, textColor, gridColor) {
    if (!ctx) return;
    new Chart(ctx, {
        type: 'line',
        data: {
            labels: monthLabels,
            datasets: [{
                label: 'Gamerscore',
                data: stats.monthly_stats.map(m => m.gamerscore_earned || 0),
                borderColor: '#f59e0b',
                backgroundColor: 'rgba(245, 158, 11, 0.1)',
                fill: true,
                tension: 0.3,
                pointRadius: 4,
                pointHoverRadius: 6,
                pointBackgroundColor: '#f59e0b',
            }]
        },
        options: {
            responsive: true,
            plugins: { legend: { display: false } },
            scales: {
                x: { ticks: { color: textColor }, grid: { color: gridColor } },
                y: { ticks: { color: textColor }, grid: { color: gridColor }, beginAtZero: true },
            },
        },
    });
}

function _initAchievementsChart(ctx, monthLabels, stats, textColor, gridColor, xboxGreen) {
    if (!ctx) return;
    new Chart(ctx, {
        type: 'bar',
        data: {
            labels: monthLabels,
            datasets: [{
                label: 'Achievements',
                data: stats.monthly_stats.map(m => m.achievement_count || 0),
                backgroundColor: xboxGreen,
                borderRadius: 4,
            }]
        },
        options: {
            responsive: true,
            plugins: { legend: { display: false } },
            scales: {
                x: { ticks: { color: textColor }, grid: { color: gridColor } },
                y: { ticks: { color: textColor, stepSize: 1 }, grid: { color: gridColor }, beginAtZero: true },
            },
        },
    });
}

function _initMostPlayedChart(ctx, stats, textColor, gridColor, xboxGreen) {
    if (!ctx || !stats.most_played?.length) return;
    const top10 = stats.most_played.slice(0, 10);
    const labels = top10.map(g => g.name.length > 25 ? g.name.substring(0, 23) + '...' : g.name);
    const hours = top10.map(g => Math.round((g.minutes_played || 0) / 60 * 10) / 10);
    new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [{ label: 'Hours', data: hours, backgroundColor: xboxGreen, borderRadius: 6 }]
        },
        options: {
            indexAxis: 'y',
            responsive: true,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (ctx) => {
                            const hours = Math.floor(ctx.raw);
                            const mins = Math.round((ctx.raw - hours) * 60);
                            return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
                        }
                    }
                }
            },
            scales: {
                x: { ticks: { color: textColor, callback: (v) => v + 'h' }, grid: { color: gridColor } },
                y: { ticks: { color: textColor, font: { size: 11 } }, grid: { display: false } },
            },
        },
    });
}

function initDashboardCharts(stats) {
    if (!stats) return;
    const style = getComputedStyle(document.documentElement);
    const textColor = style.getPropertyValue('--text-secondary').trim() || '#8b8fa3';
    const gridColor = style.getPropertyValue('--border-subtle').trim() || 'rgba(255,255,255,0.06)';
    const xboxGreen = style.getPropertyValue('--xbox-green').trim() || '#00d26a';

    const hasMonthly = stats.monthly_stats && stats.monthly_stats.length > 1;
    const monthLabels = hasMonthly ? _buildMonthLabels(stats.monthly_stats) : [];

    _initCompletionChart(document.getElementById('completionChart'), stats, textColor, xboxGreen, style);
    if (hasMonthly) {
        _initGamerscoreChart(document.getElementById('gamerscoreTimeChart'), monthLabels, stats, textColor, gridColor);
        _initAchievementsChart(document.getElementById('achievementsTimeChart'), monthLabels, stats, textColor, gridColor, xboxGreen);
    }
    _initMostPlayedChart(document.getElementById('mostPlayedChart'), stats, textColor, gridColor, xboxGreen);
}

// --- Ambient glow: extract dominant color from game art ---
function initAmbientGlow(root) {
    const scope = root || document;
    scope.querySelectorAll('.lib-grid-card').forEach(card => {
        if (card.dataset.glowSet) return;
        const img = card.querySelector('.lib-grid-art img');
        if (!img) return;
        const apply = () => {
            try {
                const canvas = document.createElement('canvas');
                canvas.width = 1; canvas.height = 1;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, 1, 1);
                const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
                card.style.setProperty('--card-glow', `rgb(${r},${g},${b})`);
                card.style.setProperty('--card-glow-rgb', `${r},${g},${b}`);
                card.dataset.glowSet = '1';
            } catch (e) { /* cross-origin — silently skip */ }
        };
        if (img.complete && img.naturalWidth) apply();
        else img.addEventListener('load', apply, { once: true });
    });
}

// --- Confetti burst for 100% completed games ---
const _confettiFired = new Set();

function fireCompletionConfetti() {
    if (typeof confetti === 'undefined') return;
    if (!document.body.classList.contains('page-game-detail')) return;
    const diamond = document.querySelector('.completion-diamond-lg');
    if (!diamond) return;

    const titleId = location.pathname.split('/game/')[1];
    if (!titleId || _confettiFired.has(titleId)) return;
    _confettiFired.add(titleId);

    const rect = diamond.getBoundingClientRect();
    const x = (rect.left + rect.width / 2) / window.innerWidth;
    const y = (rect.top + rect.height / 2) / window.innerHeight;

    const colors = ['#107c10', '#06b6d4', '#67e8f9', '#fbbf24', '#a78bfa', '#f472b6'];
    const shared = { colors, disableForReducedMotion: true, ticks: 150, gravity: 1.2, scalar: 0.85 };

    confetti({ ...shared, particleCount: 100, spread: 80, origin: { x, y }, startVelocity: 35 });
    setTimeout(() => {
        confetti({ ...shared, particleCount: 60, spread: 50, origin: { x, y }, startVelocity: 30, angle: 135 });
    }, 80);
    setTimeout(() => {
        confetti({ ...shared, particleCount: 60, spread: 50, origin: { x, y }, startVelocity: 30, angle: 45 });
    }, 80);
    setTimeout(() => {
        confetti({ ...shared, particleCount: 80, spread: 120, origin: { x, y }, startVelocity: 25, scalar: 0.6, gravity: 1.4 });
    }, 200);
}
