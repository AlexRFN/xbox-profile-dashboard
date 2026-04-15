// === charts.js ===
// Dashboard charts (Chart.js), count-up animation, ambient glow, confetti.
// globals: initDashboardCharts, animateCountUp, initAmbientGlow, fireCompletionConfetti

var _doughnutCenterPlugin = {
    id: 'doughnutCenter',
    afterDraw: function(chart) {
        if (chart.config.type !== 'doughnut' || !chart.options.plugins.doughnutCenter) return;
        var cfg = chart.options.plugins.doughnutCenter;
        var ctx = chart.ctx;
        var area = chart.chartArea;
        var cx = (area.left + area.right) / 2;
        var cy = (area.top + area.bottom) / 2;

        ctx.save();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        ctx.font = "700 " + (cfg.valueSize || 28) + "px 'Rajdhani', system-ui, sans-serif";
        ctx.fillStyle = cfg.valueColor || '#00d26a';
        ctx.fillText(cfg.value || '', cx, cy - 8);

        ctx.font = "600 " + (cfg.labelSize || 11) + "px 'Rajdhani', system-ui, sans-serif";
        ctx.fillStyle = cfg.labelColor || '#8b8fa3';
        ctx.letterSpacing = '0.08em';
        ctx.fillText((cfg.label || '').toUpperCase(), cx, cy + 14);

        ctx.restore();
    }
};

// --- Count-up animation for stat cards ---
function animateCountUp() {
    document.querySelectorAll('[data-countup]').forEach(el => {
        if (el.dataset.countupInit) return;
        el.dataset.countupInit = '1';

        const text = el.textContent.trim();
        const match = text.match(/^[\d,]+/);
        if (!match) return;

        const target = parseInt(match[0].replace(/,/g, ''), 10);
        if (isNaN(target) || target === 0) return;

        const suffix = text.slice(match[0].length);

        function startCount() {
            const duration = 1200;
            const start = performance.now();
            function step(now) {
                const elapsed = now - start;
                const progress = Math.min(elapsed / duration, 1);
                const eased = 1 - Math.pow(1 - progress, 3);
                el.textContent = Math.round(target * eased).toLocaleString() + suffix;
                if (progress < 1) requestAnimationFrame(step);
                else el.textContent = target.toLocaleString() + suffix;
            }
            requestAnimationFrame(step);
        }

        // Start counting the moment the card's entrance animation fires.
        // The stat card is article.anim-blur-rise — watch for animate-in on that ancestor.
        const container = el.closest('.anim-blur-rise, .anim-drop, .anim-pop, .anim-blur-scale, .anim-slide-blur, .anim-grow');
        el.textContent = '0' + suffix;

        if (!container || container.classList.contains('animate-in')) {
            startCount();
            return;
        }

        const obs = new MutationObserver(() => {
            if (container.classList.contains('animate-in')) {
                obs.disconnect();
                startCount();
            }
        });
        obs.observe(container, { attributes: true, attributeFilter: ['class'] });
    });
}

// --- Dashboard Charts ---

var _dashboardCharts = [];

function _buildMonthLabels(monthlyStats) {
    return monthlyStats.map(m => {
        const [y, mo] = m.month.split('-');
        return new Date(y, parseInt(mo) - 1).toLocaleString('default', { month: 'short', year: '2-digit' });
    });
}

function _glassGradient(ctx, colorStart, colorEnd) {
    const g = ctx.createLinearGradient(0, 0, 0, ctx.canvas.height);
    g.addColorStop(0, colorStart);
    g.addColorStop(1, colorEnd);
    return g;
}

function _glassTooltip() {
    return {
        backgroundColor: 'rgba(10, 10, 16, 0.75)',
        borderColor: 'rgba(255, 255, 255, 0.10)',
        borderWidth: 1,
        titleFont: { family: "'Rajdhani', system-ui, sans-serif", weight: '600', size: 13 },
        bodyFont: { family: "'Inter', system-ui, sans-serif", size: 12 },
        titleColor: '#e8eaed',
        bodyColor: '#8b8fa3',
        padding: { top: 8, bottom: 8, left: 12, right: 12 },
        cornerRadius: 10,
        displayColors: true,
        boxPadding: 4,
    };
}

function _glassScales(textColor, gridColor) {
    return {
        x: {
            ticks: { color: textColor, font: { family: "'Inter', system-ui, sans-serif", size: 11 } },
            grid: { color: gridColor, lineWidth: 0.5 },
            border: { display: false },
        },
        y: {
            ticks: { color: textColor, font: { family: "'Inter', system-ui, sans-serif", size: 11 } },
            grid: { color: gridColor, lineWidth: 0.5 },
            border: { display: false },
            beginAtZero: true,
        },
    };
}

function _initCompletionChart(ctx, stats, textColor, xboxGreen, style) {
    if (!ctx || stats.zero_progress === undefined) return null;
    var total = (stats.zero_progress || 0) + (stats.low_progress || 0) + (stats.high_progress || 0) + (stats.completed_games || 0);
    var pct = total > 0 ? Math.round((stats.completed_games / total) * 100) : 0;
    return new Chart(ctx, {
        type: 'doughnut',
        plugins: [_doughnutCenterPlugin],
        data: {
            labels: ['0%', '1-50%', '51-99%', '100%'],
            datasets: [{
                data: [stats.zero_progress, stats.low_progress, stats.high_progress, stats.completed_games],
                backgroundColor: [
                    'rgba(80, 83, 102, 0.6)',
                    'rgba(245, 158, 11, 0.55)',
                    'rgba(59, 130, 246, 0.55)',
                    'rgba(0, 210, 106, 0.6)',
                ],
                borderColor: 'transparent',
                borderWidth: 0,
                hoverBackgroundColor: [
                    'rgba(80, 83, 102, 0.85)',
                    'rgba(245, 158, 11, 0.80)',
                    'rgba(59, 130, 246, 0.80)',
                    'rgba(0, 210, 106, 0.85)',
                ],
                spacing: 3,
                borderRadius: 4,
            }]
        },
        options: {
            responsive: true,
            cutout: '62%',
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: {
                        color: textColor,
                        font: { family: "'Rajdhani', system-ui, sans-serif", size: 12, weight: '600' },
                        padding: 16,
                        usePointStyle: true,
                        pointStyleWidth: 10,
                    },
                },
                tooltip: _glassTooltip(),
                doughnutCenter: {
                    value: pct + '%',
                    label: 'completed',
                    valueColor: xboxGreen,
                    labelColor: textColor,
                    valueSize: 28,
                    labelSize: 11,
                },
            },
        },
    });
}

function _initGamerscoreChart(ctx, monthLabels, stats, textColor, gridColor) {
    if (!ctx) return null;
    const canvas = ctx.getContext('2d');
    const fillGrad = _glassGradient(canvas, 'rgba(245, 158, 11, 0.25)', 'rgba(245, 158, 11, 0.02)');
    return new Chart(ctx, {
        type: 'line',
        data: {
            labels: monthLabels,
            datasets: [{
                label: 'Gamerscore',
                data: stats.monthly_stats.map(m => m.gamerscore_earned || 0),
                borderColor: 'rgba(245, 158, 11, 0.8)',
                backgroundColor: fillGrad,
                fill: true,
                tension: 0.4,
                cubicInterpolationMode: 'monotone',
                pointRadius: 3,
                pointHoverRadius: 7,
                pointBackgroundColor: 'rgba(245, 158, 11, 0.9)',
                pointBorderColor: 'rgba(245, 158, 11, 0.3)',
                pointBorderWidth: 4,
                pointHoverBorderColor: 'rgba(245, 158, 11, 0.5)',
                pointHoverBorderWidth: 8,
                borderWidth: 2,
            }]
        },
        options: {
            responsive: true,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: false },
                tooltip: {
                    ..._glassTooltip(),
                    callbacks: {
                        label: function(c) { return ' ' + (c.raw || 0).toLocaleString() + 'G'; }
                    }
                },
            },
            scales: {
                ..._glassScales(textColor, gridColor),
                y: { ..._glassScales(textColor, gridColor).y, ticks: { ..._glassScales(textColor, gridColor).y.ticks, callback: function(v) { return v.toLocaleString() + 'G'; } } },
            },
        },
    });
}

function _initAchievementsChart(ctx, monthLabels, stats, textColor, gridColor, xboxGreen) {
    if (!ctx) return null;
    const canvas = ctx.getContext('2d');
    const barGrad = _glassGradient(canvas, 'rgba(0, 210, 106, 0.6)', 'rgba(0, 210, 106, 0.20)');
    return new Chart(ctx, {
        type: 'bar',
        data: {
            labels: monthLabels,
            datasets: [{
                label: 'Achievements',
                data: stats.monthly_stats.map(m => m.achievement_count || 0),
                backgroundColor: barGrad,
                hoverBackgroundColor: 'rgba(0, 210, 106, 0.75)',
                borderColor: 'rgba(0, 210, 106, 0.30)',
                hoverBorderColor: 'rgba(0, 210, 106, 0.60)',
                borderWidth: 1,
                borderRadius: 6,
                borderSkipped: false,
            }]
        },
        options: {
            responsive: true,
            interaction: { mode: 'index', intersect: false },
            plugins: { legend: { display: false }, tooltip: _glassTooltip() },
            scales: {
                ..._glassScales(textColor, gridColor),
                y: { ..._glassScales(textColor, gridColor).y, ticks: { ..._glassScales(textColor, gridColor).y.ticks, stepSize: 1 } },
            },
        },
    });
}

function _initMostPlayedChart(ctx, stats, textColor, gridColor, xboxGreen) {
    if (!ctx || !stats.most_played?.length) return null;
    const top10 = stats.most_played.slice(0, 10);
    const labels = top10.map(g => g.name.length > 25 ? g.name.substring(0, 23) + '...' : g.name);
    const hours = top10.map(g => Math.round((g.minutes_played || 0) / 60 * 10) / 10);
    const canvas = ctx.getContext('2d');
    const barGrad = canvas.createLinearGradient(0, 0, canvas.canvas.width, 0);
    barGrad.addColorStop(0, 'rgba(0, 210, 106, 0.15)');
    barGrad.addColorStop(1, 'rgba(0, 210, 106, 0.55)');
    return new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [{
                label: 'Hours',
                data: hours,
                backgroundColor: barGrad,
                hoverBackgroundColor: 'rgba(0, 210, 106, 0.70)',
                hoverBorderColor: 'rgba(0, 210, 106, 0.50)',
                borderColor: 'rgba(0, 210, 106, 0.25)',
                borderWidth: 1,
                borderRadius: 6,
                borderSkipped: false,
            }]
        },
        options: {
            indexAxis: 'y',
            responsive: true,
            plugins: {
                legend: { display: false },
                tooltip: {
                    ..._glassTooltip(),
                    callbacks: {
                        label: (c) => {
                            const h = Math.floor(c.raw);
                            const m = Math.round((c.raw - h) * 60);
                            return h > 0 ? ` ${h}h ${m}m` : ` ${m}m`;
                        }
                    }
                }
            },
            scales: {
                x: {
                    ticks: { color: textColor, font: { family: "'Inter', system-ui, sans-serif", size: 11 }, callback: (v) => v + 'h' },
                    grid: { color: gridColor, lineWidth: 0.5 },
                    border: { display: false },
                },
                y: {
                    ticks: { color: textColor, font: { family: "'Rajdhani', system-ui, sans-serif", size: 12, weight: '600' } },
                    grid: { display: false },
                    border: { display: false },
                },
            },
        },
    });
}

function initDashboardCharts(stats) {
    _dashboardCharts.forEach(function(c) { try { c.destroy(); } catch (e) {} });
    _dashboardCharts = [];
    if (!stats) return;
    const style = getComputedStyle(document.documentElement);
    const textColor = style.getPropertyValue('--text-secondary').trim() || '#8b8fa3';
    const gridColor = style.getPropertyValue('--border-subtle').trim() || 'rgba(255,255,255,0.06)';
    const xboxGreen = style.getPropertyValue('--xbox-green').trim() || '#00d26a';

    const hasMonthly = stats.monthly_stats && stats.monthly_stats.length > 1;
    const monthLabels = hasMonthly ? _buildMonthLabels(stats.monthly_stats) : [];

    const created = [
        _initCompletionChart(document.getElementById('completionChart'), stats, textColor, xboxGreen, style),
        hasMonthly ? _initGamerscoreChart(document.getElementById('gamerscoreTimeChart'), monthLabels, stats, textColor, gridColor) : null,
        hasMonthly ? _initAchievementsChart(document.getElementById('achievementsTimeChart'), monthLabels, stats, textColor, gridColor, xboxGreen) : null,
        _initMostPlayedChart(document.getElementById('mostPlayedChart'), stats, textColor, gridColor, xboxGreen),
    ];
    _dashboardCharts = created.filter(Boolean);
}

// --- Ambient glow: extract dominant color from game art ---
function initAmbientGlow(root) {
    const scope = root || document;
    scope.querySelectorAll('.lib-grid-card').forEach(card => {
        if (card.dataset.glowSet) return;
        const img = card.querySelector('.lib-grid-art img');
        if (!img) return;

        // Fast path: extract dominant color from blurhash DC component.
        // The DC value encodes the average image color as a 24-bit sRGB integer —
        // identical purpose to the 1×1 canvas approach but requires no image decode,
        // no canvas allocation, and no GPU readback. O(1) per card.
        const hash = img.dataset.blurhash;
        if (hash && hash.length >= 6) {
            const color = _bhDominantColor(hash);   // "rgb(r,g,b)" — defined in blurhash.js
            const rgb   = color.slice(4, -1);        // "r,g,b"
            card.style.setProperty('--card-glow', color);
            card.style.setProperty('--card-glow-rgb', rgb);
            card.dataset.glowSet = '1';
            return;
        }

        // Fallback: canvas readback for cards that have no blurhash stored.
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
