// === charts.worker.js ===
// Off-main-thread Chart.js renderer using OffscreenCanvas. Main thread
// transfers a canvas per chart, sends {kind, stats, theme}; worker owns
// the Chart instance, handles resize and forwarded pointer events for
// hover tooltips. Animation is disabled (no rAF in worker scope —
// Chart.js falls back to sync callbacks, which pop-in cleanly).

importScripts('/static/js/vendor/chart.umd.min.js');

// --- Doughnut center-text plugin (mirror of main-thread _doughnutCenterPlugin) ---
const DOUGHNUT_CENTER = {
    id: 'doughnutCenter',
    afterDraw(chart) {
        if (chart.config.type !== 'doughnut' || !chart.options.plugins.doughnutCenter) return;
        const cfg = chart.options.plugins.doughnutCenter;
        const ctx = chart.ctx;
        const area = chart.chartArea;
        const cx = (area.left + area.right) / 2;
        const cy = (area.top + area.bottom) / 2;
        ctx.save();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = "700 " + (cfg.valueSize || 28) + "px 'Rajdhani', system-ui, sans-serif";
        ctx.fillStyle = cfg.valueColor || '#00d26a';
        ctx.fillText(cfg.value || '', cx, cy - 8);
        ctx.font = "600 " + (cfg.labelSize || 11) + "px 'Rajdhani', system-ui, sans-serif";
        ctx.fillStyle = cfg.labelColor || '#8b8fa3';
        ctx.fillText((cfg.label || '').toUpperCase(), cx, cy + 14);
        ctx.restore();
    }
};

// --- Shared styling helpers ---
function glassTooltip() {
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

function glassScales(textColor, gridColor) {
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

function buildMonthLabels(monthlyStats) {
    return monthlyStats.map(m => {
        const [y, mo] = m.month.split('-');
        return new Date(y, parseInt(mo) - 1).toLocaleString('default', { month: 'short', year: '2-digit' });
    });
}

function vGrad(ctx, h, c0, c1) {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, c0); g.addColorStop(1, c1);
    return g;
}

function hGrad(ctx, w, c0, c1) {
    const g = ctx.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0, c0); g.addColorStop(1, c1);
    return g;
}

// --- Chart builders (mirror the main-thread _init* functions) ---

function buildCompletion(canvas, stats, theme) {
    const total = (stats.zero_progress || 0) + (stats.low_progress || 0) + (stats.high_progress || 0) + (stats.completed_games || 0);
    const pct = total > 0 ? Math.round((stats.completed_games / total) * 100) : 0;
    return {
        type: 'doughnut',
        plugins: [DOUGHNUT_CENTER],
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
            responsive: false,
            maintainAspectRatio: false,
            animation: false,
            cutout: '62%',
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: {
                        color: theme.textColor,
                        font: { family: "'Rajdhani', system-ui, sans-serif", size: 12, weight: '600' },
                        padding: 16,
                        usePointStyle: true,
                        pointStyleWidth: 10,
                    },
                },
                tooltip: glassTooltip(),
                doughnutCenter: {
                    value: pct + '%',
                    label: 'completed',
                    valueColor: theme.xboxGreen,
                    labelColor: theme.textColor,
                    valueSize: 28,
                    labelSize: 11,
                },
            },
        },
    };
}

function buildGamerscore(canvas, stats, theme, monthLabels) {
    const ctx = canvas.getContext('2d');
    const fillGrad = vGrad(ctx, canvas.height, 'rgba(245, 158, 11, 0.25)', 'rgba(245, 158, 11, 0.02)');
    const sc = glassScales(theme.textColor, theme.gridColor);
    return {
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
            responsive: false,
            maintainAspectRatio: false,
            animation: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: false },
                tooltip: {
                    ...glassTooltip(),
                    callbacks: {
                        label: (c) => ' ' + (c.raw || 0).toLocaleString() + 'G',
                    },
                },
            },
            scales: {
                ...sc,
                y: { ...sc.y, ticks: { ...sc.y.ticks, callback: (v) => v.toLocaleString() + 'G' } },
            },
        },
    };
}

function buildAchievements(canvas, stats, theme, monthLabels) {
    const ctx = canvas.getContext('2d');
    const barGrad = vGrad(ctx, canvas.height, 'rgba(0, 210, 106, 0.6)', 'rgba(0, 210, 106, 0.20)');
    const sc = glassScales(theme.textColor, theme.gridColor);
    return {
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
            responsive: false,
            maintainAspectRatio: false,
            animation: false,
            interaction: { mode: 'index', intersect: false },
            plugins: { legend: { display: false }, tooltip: glassTooltip() },
            scales: {
                ...sc,
                y: { ...sc.y, ticks: { ...sc.y.ticks, stepSize: 1 } },
            },
        },
    };
}

function buildMostPlayed(canvas, stats, theme) {
    const top10 = stats.most_played.slice(0, 10);
    const labels = top10.map(g => g.name.length > 25 ? g.name.substring(0, 23) + '...' : g.name);
    const hours = top10.map(g => Math.round((g.minutes_played || 0) / 60 * 10) / 10);
    const ctx = canvas.getContext('2d');
    const barGrad = hGrad(ctx, canvas.width, 'rgba(0, 210, 106, 0.15)', 'rgba(0, 210, 106, 0.55)');
    return {
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
            responsive: false,
            maintainAspectRatio: false,
            animation: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    ...glassTooltip(),
                    callbacks: {
                        label: (c) => {
                            const h = Math.floor(c.raw);
                            const m = Math.round((c.raw - h) * 60);
                            return h > 0 ? ` ${h}h ${m}m` : ` ${m}m`;
                        },
                    },
                },
            },
            scales: {
                x: {
                    ticks: { color: theme.textColor, font: { family: "'Inter', system-ui, sans-serif", size: 11 }, callback: (v) => v + 'h' },
                    grid: { color: theme.gridColor, lineWidth: 0.5 },
                    border: { display: false },
                },
                y: {
                    ticks: { color: theme.textColor, font: { family: "'Rajdhani', system-ui, sans-serif", size: 12, weight: '600' } },
                    grid: { display: false },
                    border: { display: false },
                },
            },
        },
    };
}

const BUILDERS = {
    completion: (c, s, t) => buildCompletion(c, s, t),
    gamerscore: (c, s, t) => buildGamerscore(c, s, t, buildMonthLabels(s.monthly_stats)),
    achievements: (c, s, t) => buildAchievements(c, s, t, buildMonthLabels(s.monthly_stats)),
    mostPlayed: (c, s, t) => buildMostPlayed(c, s, t),
};

// --- Chart registry + message handler ---

const _charts = new Map();

// Set canvas dimensions in CSS pixels. Chart.js multiplies by
// devicePixelRatio internally via retinaScale to produce the backing store,
// and keeps chart.width/height in CSS pixels so mouse events (also CSS px)
// align with element positions for hover/tooltip. Pre-scaling here would
// make Chart.js read the pre-scaled size as logical and double-apply dpr.
// Skip when unchanged so redundant resizes don't clear the bitmap.
function setCanvasSize(canvas, width, height) {
    const newW = Math.round(width);
    const newH = Math.round(height);
    if (canvas.width === newW && canvas.height === newH) return false;
    canvas.width = newW;
    canvas.height = newH;
    return true;
}

self.onmessage = (e) => {
    const msg = e.data;
    try {
        if (msg.type === 'create') {
            const { id, kind, canvas, stats, theme, width, height, dpr } = msg;
            const builder = BUILDERS[kind];
            if (!builder) { self.postMessage({ type: 'error', id, message: 'unknown kind: ' + kind }); return; }
            setCanvasSize(canvas, width, height);
            const config = builder(canvas, stats, theme);
            if (!config.options) config.options = {};
            config.options.devicePixelRatio = dpr;
            const chart = new Chart(canvas, config);
            _charts.set(id, { chart, canvas, dpr });
        } else if (msg.type === 'resize') {
            const entry = _charts.get(msg.id);
            if (!entry) return;
            const dpr = msg.dpr || entry.dpr || 1;
            entry.dpr = dpr;
            const changed = setCanvasSize(entry.canvas, msg.width, msg.height);
            if (changed) {
                entry.chart.resize(msg.width, msg.height);
                // Force a synchronous redraw — Chart.js internal size check may
                // short-circuit update, leaving the cleared canvas blank.
                entry.chart.update('none');
            }
        } else if (msg.type === 'pointer') {
            const entry = _charts.get(msg.id);
            if (!entry) return;
            const chart = entry.chart;
            if (msg.x == null) {
                chart.setActiveElements([]);
                chart.tooltip.setActiveElements([], { x: 0, y: 0 });
            } else {
                // getRelativePosition(evt, chart) returns {x:evt.x, y:evt.y} when
                // 'native' in evt is truthy — pass native:null so our CSS-pixel
                // coords are used directly instead of DOM-event extraction.
                const synth = { x: msg.x, y: msg.y, type: 'mousemove', native: null };
                const mode = chart.options.interaction && chart.options.interaction.mode ? chart.options.interaction.mode : 'nearest';
                const modeFn = Chart.Interaction && Chart.Interaction.modes && Chart.Interaction.modes[mode];
                const elements = modeFn ? modeFn(chart, synth, { intersect: false }, true) : [];
                if (elements.length) {
                    chart.tooltip.setActiveElements(elements, { x: msg.x, y: msg.y });
                    chart.setActiveElements(elements);
                } else {
                    chart.setActiveElements([]);
                    chart.tooltip.setActiveElements([], { x: 0, y: 0 });
                }
            }
            chart.update('none');
        } else if (msg.type === 'destroy') {
            const entry = _charts.get(msg.id);
            if (entry) {
                try { entry.chart.destroy(); } catch (_) { /* ignore */ }
                _charts.delete(msg.id);
            }
        }
    } catch (err) {
        self.postMessage({ type: 'error', id: msg && msg.id, message: String(err && err.message || err) });
    }
};
