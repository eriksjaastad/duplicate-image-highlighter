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

    // --- CONFIGURATION ---

    /**
     * Hamming distance threshold for near-duplicate detection.
     * - Lower = stricter matching (fewer false positives, may miss similar images)
     * - Higher = looser matching (catches more duplicates, but may have false positives)
     *
     * With a 32x31 dHash (992 bits / 248 hex chars), typical thresholds:
     * - 0: Exact match only
     * - 5: Very similar images (compression artifacts, slight crops) [RECOMMENDED]
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
     * Maximum number of entries to keep in memory maps.
     * Prevents unbounded memory growth on infinite-scroll pages.
     * When the limit is reached, the oldest entries are evicted.
     */
    const MAX_CACHE_ENTRIES = 5000;

    /**
     * Maximum number of failed URLs to track.
     * Prevents a memory leak if many images fail to load (404s, non-images, etc).
     */
    const MAX_FAILED_ENTRIES = 1000;

    /**
     * DOM changes are handled at most this often (ms), however busy the page is.
     */
    const MUTATION_INTERVAL = 500;

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
    // The image's previous inline outline is saved and restored on clear.

    // img element -> { saved: its inline outline before we changed it, applied: what we set }
    const savedOutline = new WeakMap();

    function clearDecoration(img) {
        const entry = savedOutline.get(img);
        if (!entry) return;
        savedOutline.delete(img);
        // If the page changed the outline since we set it, the page's value wins.
        if (img.style.getPropertyValue('outline') !== entry.applied) return;
        for (const [prop, value, priority] of entry.saved) {
            if (value) {
                img.style.setProperty(prop, value, priority);
            } else {
                img.style.removeProperty(prop);
            }
        }
    }

    function markDuplicate(img, count) {
        if (count <= 1) {
            clearDecoration(img);
            return;
        }
        if (!savedOutline.has(img)) {
            savedOutline.set(img, {
                saved: ['outline', 'outline-offset'].map(
                    (prop) => [prop, img.style.getPropertyValue(prop), img.style.getPropertyPriority(prop)]
                ),
                applied: null
            });
        }
        // important: page stylesheets must not hide the highlight
        img.style.setProperty('outline', `4px solid ${colorForCount(count)}`, 'important');
        img.style.setProperty('outline-offset', '-4px', 'important');
        savedOutline.get(img).applied = img.style.getPropertyValue('outline');
    }

    // --- HASH MATCHING ---

    /**
     * Find a matching hash using exact match first, then Hamming distance.
     * Returns the matching hash key or null.
     */
    function findMatchingHash(newHash, hashMap) {
        if (hashMap.has(newHash)) return newHash;

        for (const existingHash of hashMap.keys()) {
            if (DuplicateImageHash.hammingDistance(newHash, existingHash, HAMMING_THRESHOLD) <= HAMMING_THRESHOLD) {
                return existingHash;
            }
        }
        return null;
    }

    /**
     * Skip solid-color placeholders: their hashes are all one bit value.
     */
    function isSolidColor(hash) {
        if (!hash) return false;
        return /^0+$/.test(hash) || /^f+$/.test(hash);
    }

    /**
     * Get the effective source URL for an image (handles responsive images).
     */
    function getImageSrc(img) {
        return img.currentSrc || img.src;
    }

    // --- STATE ---

    // src URL -> hash group key
    const processedSrcUrls = new Map();

    // hash group key -> Set of src URLs (more than one = duplicates)
    const hashToSrcUrls = new Map();

    // URLs that failed to hash (avoid retry loops; a rescan retries them)
    const failedUrls = new Set();

    // img element -> src it was last queued with (re-queue when the src changes)
    let observedSrc = new WeakMap();

    // Images with a pending 'load' listener, so a rescan does not add a second one
    const awaitingLoad = new WeakSet();

    /**
     * Evicts the oldest entries from caches when they exceed their limits.
     */
    function evictOldestEntries() {
        if (processedSrcUrls.size > MAX_CACHE_ENTRIES) {
            const entriesToRemove = processedSrcUrls.size - MAX_CACHE_ENTRIES;
            let removed = 0;

            for (const [src, hash] of processedSrcUrls) {
                if (removed >= entriesToRemove) break;

                processedSrcUrls.delete(src);

                const srcSet = hashToSrcUrls.get(hash);
                if (srcSet) {
                    srcSet.delete(src);
                    if (srcSet.size === 0) hashToSrcUrls.delete(hash);
                }
                removed++;
            }

            console.log(`${LOG_PREFIX} Evicted ${removed} old entries from cache`);
        }

        // Clear the oldest half of failed URLs when the limit is exceeded
        if (failedUrls.size > MAX_FAILED_ENTRIES) {
            const entriesToRemove = Math.floor(failedUrls.size / 2);
            let removed = 0;

            for (const url of failedUrls) {
                if (removed >= entriesToRemove) break;
                failedUrls.delete(url);
                removed++;
            }

            console.log(`${LOG_PREFIX} Evicted ${removed} failed URL entries`);
        }
    }

    function duplicateGroupCount() {
        let groups = 0;
        for (const srcSet of hashToSrcUrls.values()) {
            if (srcSet.size > 1) groups++;
        }
        return groups;
    }

    /**
     * Re-apply highlighting to an image whose src is already hashed.
     */
    function applyKnownHighlight(img, src) {
        const srcSet = hashToSrcUrls.get(processedSrcUrls.get(src));
        if (srcSet && srcSet.size > 1) markDuplicate(img, srcSet.size);
    }

    /**
     * Update every image on the page that belongs to a hash group.
     */
    function updateAllMatchingImages(targetHash) {
        const matchingSrcs = hashToSrcUrls.get(targetHash);
        if (!matchingSrcs || matchingSrcs.size <= 1) return;

        document.querySelectorAll('img').forEach(pageImg => {
            if (matchingSrcs.has(getImageSrc(pageImg))) {
                markDuplicate(pageImg, matchingSrcs.size);
            }
        });
    }

    // --- TOOLBAR BADGE ---

    let statusTimer = null;

    /**
     * Tell the service worker how the scan is going, debounced so a burst of
     * hashes produces one update and the final one sees an empty queue.
     */
    function reportStatus() {
        clearTimeout(statusTimer);
        statusTimer = setTimeout(() => {
            chrome.runtime.sendMessage({
                action: 'SCAN_STATUS',
                pending: DuplicateImageHash.pendingCount(),
                groups: duplicateGroupCount()
            }, () => {
                // The service worker may be restarting; the next update retries.
                void chrome.runtime.lastError;
            });
        }, 250);
    }

    // --- PAGE PROCESSING ---

    /**
     * Hash a single image and check it against everything seen so far.
     */
    function processImage(img) {
        const src = getImageSrc(img);

        if (processedSrcUrls.has(src)) {
            applyKnownHighlight(img, src);
            return;
        }
        if (failedUrls.has(src)) return;

        DuplicateImageHash.queueHash(src).then((realHash) => {
            if (!realHash) {
                failedUrls.add(src);
                reportStatus();
                return;
            }

            if (isSolidColor(realHash)) {
                reportStatus();
                return;
            }

            // The same src may have been queued twice (two elements) and hashed already
            if (processedSrcUrls.has(src)) {
                reportStatus();
                return;
            }

            const targetKey = findMatchingHash(realHash, hashToSrcUrls) || realHash;
            processedSrcUrls.set(src, targetKey);

            if (!hashToSrcUrls.has(targetKey)) {
                hashToSrcUrls.set(targetKey, new Set());
            }
            const matchingSrcs = hashToSrcUrls.get(targetKey);
            matchingSrcs.add(src);

            // Several DIFFERENT src URLs with the same hash = visual duplicates
            if (matchingSrcs.size > 1) {
                updateAllMatchingImages(targetKey);
            }
            reportStatus();
        });
        reportStatus();
    }

    function isHashable(img) {
        const src = getImageSrc(img);
        return src.startsWith('http://') || src.startsWith('https://');
    }

    function isLargeEnough(img) {
        return img.naturalWidth > MIN_WIDTH && img.naturalHeight > MIN_HEIGHT;
    }

    /**
     * Process an image that reached the viewport. Lazy-loaded images may not
     * have pixels yet; wait for them instead of skipping them for good.
     */
    function handleVisibleImage(img) {
        if (!isHashable(img)) return;

        if (img.complete && img.naturalWidth > 0) {
            if (isLargeEnough(img)) processImage(img);
            return;
        }

        if (awaitingLoad.has(img)) return;
        awaitingLoad.add(img);
        img.addEventListener('load', () => {
            awaitingLoad.delete(img);
            if (isHashable(img) && isLargeEnough(img)) processImage(img);
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
            handleVisibleImage(entry.target);
        }
    }, {
        rootMargin: '500px',
        threshold: 0
    });

    /**
     * Find images not yet queued (or whose src changed) and observe them.
     */
    function observeNewImages() {
        evictOldestEntries();

        for (const img of document.querySelectorAll('img')) {
            const src = getImageSrc(img);
            if (observedSrc.get(img) === src) continue;
            if (observedSrc.has(img)) clearDecoration(img); // src changed: old highlight no longer applies
            observedSrc.set(img, src);

            if (processedSrcUrls.has(src)) {
                applyKnownHighlight(img, src);
                continue;
            }
            if (failedUrls.has(src)) continue;

            imageObserver.observe(img);
        }
        reportStatus();
    }

    /**
     * Toolbar click on an active tab: retry failed images and look at every
     * image again.
     */
    function rescan() {
        failedUrls.clear();
        observedSrc = new WeakMap();
        observeNewImages();
    }

    // --- KEYBOARD SHORTCUTS ---

    window.addEventListener('keydown', (e) => {
        if (!e.altKey || !e.shiftKey) return;

        // Alt + Shift + D = debug dump to the console
        if (e.code === 'KeyD') {
            e.preventDefault();
            console.log(`${LOG_PREFIX} Processed URLs:`, processedSrcUrls.size);
            console.log(`${LOG_PREFIX} Unique hashes:`, hashToSrcUrls.size);
            console.log(`${LOG_PREFIX} Failed URLs:`, failedUrls.size);

            const duplicates = [];
            for (const [hash, srcSet] of hashToSrcUrls) {
                if (srcSet.size > 1) {
                    duplicates.push({
                        hash: hash.substring(0, 16) + '...',
                        count: srcSet.size,
                        urls: Array.from(srcSet)
                    });
                }
            }
            console.table(duplicates);
        }

        // Alt + Shift + S = rescan now (same as clicking the toolbar button)
        if (e.code === 'KeyS') {
            e.preventDefault();
            rescan();
        }
    });

    // --- DOM CHANGES (infinite scroll, SPAs, lazy src swaps) ---

    // Throttled, not debounced: a page that never stops changing still gets scanned.
    let mutationTimer = null;
    const domObserver = new MutationObserver(() => {
        if (mutationTimer !== null) return;
        mutationTimer = setTimeout(() => {
            mutationTimer = null;
            observeNewImages();
        }, MUTATION_INTERVAL);
    });

    domObserver.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src', 'srcset']
    });

    window.__duplicateImageHighlighter = { rescan };

    console.log(`${LOG_PREFIX} Active on this tab.`);
    observeNewImages();
})();
