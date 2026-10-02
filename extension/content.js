/**
 * Content script, injected into the top frame of a tab when the toolbar
 * button is clicked. Hashes images as they approach the viewport and
 * highlights every image that looks like another image on the same page.
 *
 * All state is in memory, per tab, and gone on navigation or reload.
 */
(function () {
    // A second click re-injects this file: rescan instead of starting over.
    if (window.__duplicateImageHighlighter) {
        window.__duplicateImageHighlighter.rescan();
        return;
    }

    const LOG_PREFIX = '[DuplicateImageHighlighter]';
    const DuplicateImageHash = window.DuplicateImageHash;
    const DuplicateImageGroups = window.DuplicateImageGroups;

    // --- CONFIGURATION ---

    /**
     * Hamming distance threshold for near-duplicate detection.
     * - Lower = stricter matching (fewer false positives, may miss similar images)
     * - Higher = looser matching (catches more duplicates, but may have false positives)
     *
     * With a 32x31 dHash (992 bits / 248 hex chars), typical thresholds:
     * - 0: Exact match only
     * - 5: Very similar images (resized, re-encoded, compression artifacts) [RECOMMENDED]
     * - 10: Moderately similar (same scene, different quality)
     * - 15+: Loose matching (may catch unrelated images)
     */
    const HAMMING_THRESHOLD = 5;

    /**
     * Images smaller than this are skipped (icons, spacers, avatars).
     */
    const MIN_WIDTH = 100;
    const MIN_HEIGHT = 50;

    /**
     * Maximum number of image URLs to remember hashes for.
     * Prevents unbounded memory growth on infinite-scroll pages.
     * When the limit is reached, the oldest URLs no longer on the page are evicted.
     */
    const MAX_CACHE_ENTRIES = 5000;

    /**
     * Maximum number of failed URLs to track.
     * Prevents a memory leak if many images fail to load (404s, non-images, etc).
     */
    const MAX_FAILED_ENTRIES = 1000;

    /**
     * DOM changes and image loads are handled at most this often (ms), however
     * busy the page is.
     */
    const MUTATION_INTERVAL = 500;

    /**
     * Highlights are recomputed at most this often (ms) while hashes arrive.
     */
    const RENDER_INTERVAL = 100;

    // --- VISUAL STYLING ---

    /**
     * Outline color by number of look-alike files: blue (2) to red (10+),
     * sweeping the hue wheel through cyan, green and yellow in between.
     */
    function colorForCount(count) {
        const maxCount = 10; // Cap at 10 for max redness
        const t = (Math.min(count, maxCount) - 2) / (maxCount - 2); // 0 at 2 copies, 1 at maxCount
        const hue = 200 - (200 * t);
        return `hsl(${hue}, 100%, 50%)`;
    }

    // --- HIGHLIGHTS ---
    //
    // A highlight is an outline drawn inside the image's own edge. Outlines take
    // no space, so the page layout never moves, and the browser keeps them
    // correctly clipped, layered and in place through scrolling and animation.
    // Each property's previous inline value is saved and restored on clear.

    // Longhands, not the `outline` shorthand: a page may set just one of them
    // inline (say outline-color), which the shorthand cannot read back.
    const OUTLINE_PROPS = ['outline-width', 'outline-style', 'outline-color', 'outline-offset'];

    // img element -> { count, props: { [prop]: { value, priority, applied } } }
    // value/priority: the page's inline value to restore; applied: what we set
    // (always with 'important' priority).
    const decorations = new Map();

    // True while a property still holds exactly what we set, value and priority.
    function stillOurs(img, prop, state) {
        return img.style.getPropertyValue(prop) === state.applied
            && img.style.getPropertyPriority(prop) === 'important';
    }

    function clearDecoration(img) {
        const entry = decorations.get(img);
        if (!entry) return;
        decorations.delete(img);
        for (const prop of OUTLINE_PROPS) {
            const state = entry.props[prop];
            const { value, priority } = state;
            // If the page changed this property since we set it, the page's value wins.
            if (!stillOurs(img, prop, state)) continue;
            if (value) {
                img.style.setProperty(prop, value, priority);
            } else {
                img.style.removeProperty(prop);
            }
        }
    }

    function markDuplicate(img, count) {
        let entry = decorations.get(img);
        if (!entry) {
            entry = { count: 0, props: {} };
            for (const prop of OUTLINE_PROPS) entry.props[prop] = { applied: null };
            decorations.set(img, entry);
        }
        const wanted = {
            'outline-width': '4px',
            'outline-style': 'solid',
            'outline-color': colorForCount(count),
            'outline-offset': '-4px'
        };
        for (const prop of OUTLINE_PROPS) {
            const state = entry.props[prop];
            const ours = stillOurs(img, prop, state);
            if (entry.count === count && ours) continue;
            // First time, or the page set its own value since: that is what to restore.
            if (!ours) {
                state.value = img.style.getPropertyValue(prop);
                state.priority = img.style.getPropertyPriority(prop);
            }
            // important: page stylesheets must not hide the highlight
            img.style.setProperty(prop, wanted[prop], 'important');
            state.applied = img.style.getPropertyValue(prop);
        }
        entry.count = count;
    }

    // --- STATE ---

    const tracker = DuplicateImageGroups.createTracker({
        threshold: HAMMING_THRESHOLD,
        maxCacheEntries: MAX_CACHE_ENTRIES,
        maxFailedEntries: MAX_FAILED_ENTRIES
    });

    // img element -> src it was handed to the IntersectionObserver with
    const watching = new Map();

    // Images with a pending 'load' listener, so a rescan does not add a second one
    const awaitingLoad = new WeakSet();

    let groupCount = 0;

    /**
     * Get the effective source URL for an image (handles responsive images).
     */
    function getImageSrc(img) {
        return img.currentSrc || img.src;
    }

    function isHashable(src) {
        return src.startsWith('http://') || src.startsWith('https://');
    }

    function isLargeEnough(img) {
        return img.naturalWidth > MIN_WIDTH && img.naturalHeight > MIN_HEIGHT;
    }

    // --- RENDERING ---

    let renderTimer = null;

    function scheduleRender() {
        if (renderTimer !== null) return;
        renderTimer = setTimeout(render, RENDER_INTERVAL);
    }

    /**
     * Outline every image whose URL is in a group of look-alikes on the page
     * now, and clear every outline that no longer applies.
     */
    function render() {
        renderTimer = null;
        const { groups, sizeBySrc } = tracker.groups();
        groupCount = groups.length;

        const stale = new Set(decorations.keys());
        for (const [img, src] of tracker.entries()) {
            const size = sizeBySrc.get(src);
            if (!size) continue;
            markDuplicate(img, size);
            stale.delete(img);
        }
        for (const img of stale) clearDecoration(img);
        reportStatus();
    }

    // --- TOOLBAR BADGE ---

    let statusTimer = null;

    /**
     * Tell the service worker how the scan is going, at most every 250ms.
     * Throttled, not debounced: the badge keeps updating while hashes keep
     * arriving, and each update reads the state when it is sent, so the last
     * one sees the empty queue.
     */
    function reportStatus() {
        if (statusTimer !== null) return;
        statusTimer = setTimeout(() => {
            statusTimer = null;
            chrome.runtime.sendMessage({
                action: 'SCAN_STATUS',
                pending: DuplicateImageHash.pendingCount(),
                groups: groupCount
            }, () => {
                // The service worker may be restarting; the next update retries.
                void chrome.runtime.lastError;
            });
        }, 250);
    }

    // --- PAGE PROCESSING ---

    /**
     * Hash an image's URL unless it is already known or being hashed.
     */
    function processImage(img) {
        if (!img.isConnected) return; // removed while waiting to load
        const src = getImageSrc(img);
        if (!tracker.needsHash(src)) return;

        if (!isLargeEnough(img)) {
            tracker.recordSkip(src);
            return;
        }

        tracker.markPending(src);
        DuplicateImageHash.queueHash(src).then((result) => {
            if (result && result.dropped) {
                tracker.cancelPending(src); // left the page before its turn
            } else {
                tracker.recordHash(src, result);
            }
            scheduleRender();
        });
        reportStatus();
    }

    /**
     * Process an image that reached the viewport. Lazy-loaded images may not
     * have pixels yet; wait for them instead of skipping them for good.
     */
    function handleVisibleImage(img) {
        if (!isHashable(getImageSrc(img))) return;

        if (img.complete && img.naturalWidth > 0) {
            processImage(img);
            return;
        }

        if (awaitingLoad.has(img)) return;
        awaitingLoad.add(img);
        img.addEventListener('load', () => {
            awaitingLoad.delete(img);
            if (isHashable(getImageSrc(img))) processImage(img);
        }, { once: true });
    }

    // --- VIEWPORT-BASED PROCESSING ---

    /**
     * Hash images as they approach the viewport, starting 500px before they
     * become visible.
     */
    const imageObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            imageObserver.unobserve(entry.target);
            watching.delete(entry.target);
            handleVisibleImage(entry.target);
        }
    }, {
        rootMargin: '500px',
        threshold: 0
    });

    /**
     * Record which image URLs are on the page now, watch images whose URL
     * still needs hashing, and drop work for images that have gone.
     */
    function scanPage() {
        const onPage = [];
        const all = document.querySelectorAll('img');
        const present = new Set(all);
        for (const img of watching.keys()) {
            if (present.has(img)) continue;
            imageObserver.unobserve(img);
            watching.delete(img);
        }
        for (const img of all) {
            const src = getImageSrc(img);
            if (!isHashable(src)) continue;
            onPage.push([img, src]);

            if (!tracker.needsHash(src)) continue;
            if (watching.get(img) === src || awaitingLoad.has(img)) continue;
            watching.set(img, src);
            imageObserver.observe(img);
        }
        tracker.sync(onPage);
        DuplicateImageHash.dropQueued((src) => !tracker.isLive(src));
        scheduleRender();
    }

    /**
     * Toolbar click on an active tab: retry failed images and look at every
     * image again.
     */
    function rescan() {
        tracker.retryFailed();
        scanPage();
    }

    // --- KEYBOARD SHORTCUTS ---

    window.addEventListener('keydown', (e) => {
        if (!e.altKey || !e.shiftKey) return;

        // Alt + Shift + D = debug dump to the console
        if (e.code === 'KeyD') {
            e.preventDefault();
            console.log(`${LOG_PREFIX} Cache:`, tracker.stats());
            console.table(tracker.groups().groups.map((srcs) => ({ count: srcs.size, urls: Array.from(srcs) })));
        }

        // Alt + Shift + S = rescan now (same as clicking the toolbar button)
        if (e.code === 'KeyS') {
            e.preventDefault();
            rescan();
        }
    });

    // --- PAGE CHANGES (infinite scroll, SPAs, lazy src swaps) ---

    // Throttled, not debounced: a page that never stops changing still gets scanned.
    let scanTimer = null;
    function scheduleScan() {
        if (scanTimer !== null) return;
        scanTimer = setTimeout(() => {
            scanTimer = null;
            scanPage();
        }, MUTATION_INTERVAL);
    }

    const domObserver = new MutationObserver(scheduleScan);

    // An image can switch URL without any DOM change: a lazy or srcset image
    // resolves currentSrc when it loads, and a resize can pick another srcset
    // candidate. Each of those fires 'load' (which does not bubble, so capture).
    document.addEventListener('load', (e) => {
        if (e.target.tagName === 'IMG') scheduleScan();
    }, true);

    domObserver.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src', 'srcset']
    });

    window.__duplicateImageHighlighter = { rescan };

    console.log(`${LOG_PREFIX} Active on this tab.`);
    scanPage();
})();
