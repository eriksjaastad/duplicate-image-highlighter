/**
 * Service worker.
 *
 * 1. Toolbar click: injects the hasher, grouper and scanner into the clicked tab's top frame.
 *    Nothing runs on a page until you click. Clicking again rescans.
 * 2. Image fetch: content scripts cannot read pixels from cross-origin images
 *    (the canvas is tainted), so they ask the service worker to fetch the
 *    image and hand it back as a data URL.
 * 3. Toolbar badge: shows "…" while hashing, then the number of duplicate
 *    groups found on the page.
 */

const IMAGE_FETCH_MAX_BYTES = 20 * 1024 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 15000;

chrome.action.onClicked.addListener(async (tab) => {
    if (tab.id === undefined) return;
    try {
        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['hash.js', 'groups.js', 'content.js']
        });
    } catch (error) {
        // Browser-internal pages (chrome://, the Web Store, PDFs) refuse injection.
        console.warn('[DuplicateImageHighlighter] Cannot run on this page:', error.message);
        await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#777' });
        await chrome.action.setBadgeText({ tabId: tab.id, text: '×' });
    }
});

// A navigation discards the injected script, so its badge would be stale.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading') {
        chrome.action.setBadgeText({ tabId, text: '' });
    }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // Only accept messages from our own content script running in a tab.
    if (sender.id !== chrome.runtime.id || !sender.tab) return false;

    if (request.action === 'SCAN_STATUS') {
        const tabId = sender.tab.id;
        const busy = request.pending > 0;
        chrome.action.setBadgeBackgroundColor({
            tabId,
            color: busy ? '#777' : (request.groups > 0 ? '#c62828' : '#2e7d32')
        });
        chrome.action.setBadgeText({ tabId, text: busy ? '…' : String(request.groups) });
        return false;
    }

    if (request.action === 'FETCH_IMAGE_BLOB') {
        fetchImageAsDataUrl(request.url)
            .then(dataUrl => sendResponse({ success: true, dataUrl }))
            .catch(error => {
                console.warn('[DuplicateImageHighlighter] Fetch failed:', request.url, error.message);
                sendResponse({ success: false, error: error.toString() });
            });
        return true; // Keep the message channel open for the async response
    }

    return false;
});

async function fetchImageAsDataUrl(url) {
    const protocol = new URL(url).protocol;
    if (protocol !== 'http:' && protocol !== 'https:') {
        throw new Error(`Unsupported protocol: ${protocol}`);
    }

    // A stalled host must not hold one of the few hashing slots forever.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
    let blob;
    try {
        // No cookies: the extension only needs public pixels, never the user's session.
        const response = await fetch(url, { credentials: 'omit', signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

        // Refuse early when the server says it is too big; re-check after download.
        const declared = Number(response.headers.get('Content-Length'));
        if (declared > IMAGE_FETCH_MAX_BYTES) throw new Error(`Image too large: ${declared} bytes`);

        const type = (response.headers.get('Content-Type') || '').toLowerCase();
        if (type && !type.startsWith('image/') && !type.startsWith('application/octet-stream')) {
            throw new Error(`Not an image: ${type}`);
        }

        blob = await response.blob();
    } finally {
        clearTimeout(timer);
    }
    if (blob.size > IMAGE_FETCH_MAX_BYTES) throw new Error(`Image too large: ${blob.size} bytes`);

    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
}
