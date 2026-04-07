// === init.js ===
// Single DOMContentLoaded handler: bootstraps all page modules.
// Must be the last file in the concat order.

document.addEventListener('DOMContentLoaded', () => {
    initPageEntrance();
    initScrollAnimations();
    initCaptureGroupAnimations();
    updateThemeButton(_savedTheme || 'dark');
    initRevealHighlight();
    initAmbientGlow();
    initClickableRows();
    initRowScrollReveal();
    initEdgeScale();
    animateCountUp();
    initNavPillTrack();
    initScrollNav();
    initHeatmapTooltip();
    initTimelineCalendar();
    initTimelineContinuationFix();
    initCmdPalette();
    initHotkeys();
    initBlurhash();
    fireCompletionConfetti();
    // Restore saved library view
    restoreLibraryView();
    // Auto-fetch friends on first visit when DB is empty
    if (document.body.classList.contains('auto-fetch-friends')) fetchFriends();
});
