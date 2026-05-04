// === init.js ===
// Single DOMContentLoaded handler: bootstraps all page modules.
// Must be the last file in the concat order.

document.addEventListener('DOMContentLoaded', () => {
    // Match the SPA re-init priority split on full page loads:
    // shell + entrance now, visual helpers next frame, heavier page utilities
    // after the entrance cascade has had room to breathe.
    const idle = window.requestIdleCallback || ((cb) => setTimeout(cb, 16));
    const CASCADE_WAIT = 680;

    initNavPillTrack();
    initScrollNav();
    initCmdPalette();
    initHotkeys();

    if (window.resumeGlass) window.resumeGlass();
    if (window.prewarmGlassPanels) window.prewarmGlassPanels();

    initPageEntrance();
    // Restore saved table/grid state before entrance classes are applied so the
    // first visible library view is the user's chosen view.
    restoreLibraryView();
    initScrollAnimations();
    initCaptureGroupAnimations();

    requestAnimationFrame(() => {
        initRevealHighlight();
        fireCompletionConfetti();

        animateCountUp();
        initHeatmapTooltip();
        initClickableRows();
        initBlurhash();
        initAmbientGlow();
        initOffscreenAnimationPause();

        setTimeout(() => idle(() => {
            initRowScrollReveal();
            initEdgeScale();
            initTimelineCalendar();
            initTimelineContinuationFix();
            if (typeof prewarmCapturesOffView === 'function') prewarmCapturesOffView();
            if (typeof updateExportLinks === 'function') updateExportLinks();
            if (document.body.classList.contains('auto-fetch-friends')) fetchFriends();
        }), CASCADE_WAIT);
    });
});
