// === theme.js ===
// Theme cycle: dark → light → oled.
// globals: toggleTheme, applyTheme, getActiveTheme, updateThemeButton

const themeCycle = ['dark', 'light', 'oled'];
const themeIcons = { dark: '\u25D1', light: '\u2600', oled: '\u25CF' };  // ◑ ☀ ●
const themeLabels = { dark: 'Dark', light: 'Light', oled: 'OLED' };

function getActiveTheme() {
    const html = document.documentElement;
    if (html.getAttribute('data-oled') === 'true') return 'oled';
    return html.getAttribute('data-theme') || 'dark';
}

function applyTheme(theme) {
    const html = document.documentElement;
    if (theme === 'oled') {
        html.setAttribute('data-theme', 'dark');
        html.setAttribute('data-oled', 'true');
    } else {
        html.setAttribute('data-theme', theme);
        html.removeAttribute('data-oled');
    }
    localStorage.setItem('theme', theme);
    updateThemeButton(theme);
}

function toggleTheme() {
    const current = getActiveTheme();
    const idx = themeCycle.indexOf(current);
    const next = themeCycle[(idx + 1) % themeCycle.length];
    applyTheme(next);
}

function updateThemeButton(theme) {
    const btn = document.querySelector('.theme-toggle');
    if (btn) {
        btn.innerHTML = themeIcons[theme] || themeIcons.dark;
        const label = `Theme: ${themeLabels[theme] || 'Dark'} (click to switch)`;
        btn.title = label;
        btn.setAttribute('aria-label', label);
    }
}

// Apply saved theme immediately (before DOM ready to avoid FOUC).
// Q1: If no saved preference, respect OS color scheme.
const _savedTheme = localStorage.getItem('theme');
if (_savedTheme) {
    applyTheme(_savedTheme);
} else if (window.matchMedia('(prefers-color-scheme: light)').matches) {
    applyTheme('light');
}
