// === minisearch.worker.js ===
// Builds the MiniSearch game index off the main thread. Receives a URL,
// fetches the games array, tokenizes + indexes, returns the serialized
// JSON index. The main thread rehydrates with MiniSearch.loadJSON().
//
// Build is the only expensive step (O(n·terms)); search itself stays on
// main for synchronous keystroke response.

importScripts('/static/js/vendor/minisearch.min.js');

const INDEX_OPTIONS = {
    fields: ['name'],
    storeFields: ['name', 'title_id', 'display_image', 'progress_percentage', 'status'],
    searchOptions: { fuzzy: 0.2, prefix: true },
};

self.onmessage = async (e) => {
    const msg = e.data;
    if (!msg || msg.type !== 'build') return;
    try {
        const res = await fetch(msg.url);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const games = await res.json();
        const index = new MiniSearch(INDEX_OPTIONS);
        index.addAll(games.map((g, i) => ({ id: i, ...g })));
        const json = JSON.stringify(index.toJSON());
        self.postMessage({ type: 'ready', json });
    } catch (err) {
        self.postMessage({ type: 'error', message: String(err && err.message || err) });
    }
};
