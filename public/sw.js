// Origin: Mana Siege - System Service Worker
self.addEventListener('install', (e) => {
    console.log('[System] Service Worker Installed');
});

self.addEventListener('fetch', (e) => {
    // Network pass-through
});