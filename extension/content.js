/**
 * Content script. Nothing runs until you click the toolbar button: the click
 * injects hash.js and then this file into the clicked tab's top frame only
 * (no iframes). Clicking again runs the observe pass again (a rescan); it does
 * not add a second observer or a second set of shortcuts.
 *
 * What counts as a duplicate:
 * - Two different image URLs whose 32x32 difference hashes (992 bits) are
 *   within Hamming distance 5 (HAMMING_THRESHOLD). The same URL twice is not
 *   a duplicate.
 * - A new hash joins the first stored hash within 5 bits, in the order
 *   hashes arrive. Matches do not chain: A~B and B~C does not put A with C.
 * - Skipped: images with no src, data: URLs, and images whose natural size
 *   is not greater than 100x50 (naturalWidth > 100 and naturalHeight > 50).
 * - Skipped: hashes that are all 0 or all f (flat placeholders).
 *
 * When to look:
 * - Images are hashed when they come within 500px of the viewport
 *   (IntersectionObserver, rootMargin 500px), at most 5 at a time.
 * - DOM changes under document.body trigger the observe pass 500ms after
 *   they stop. The first pass runs 500ms after the click.
 * - A URL that failed to hash is not retried until Alt+Shift+R.
 *
 * What you see on each image whose look-alike group has N > 1 URLs:
 * - with t = (min(N, 10) - 1) / 9, hue = 200 - 200 * t (blue at 2, red at 10+)
 * - a 3px solid outline in that hue, offset -4px, on the image
 * - div.dih-stripe: a striped overlay covering the image's parent, with
 *   45deg stripes 20 - 15 * t pixels wide
 * - div.dih-count: a pill in the parent's top-right corner showing N
 * A parent with position static is made position relative to hold them.
 *
 * Keyboard shortcuts:
 * - Alt+Shift+R: forget every hash and failure, and reload the page
 * - Alt+Shift+D: log a debug dump to the console (counts and duplicate groups)
 * - Alt+Shift+S: run the observe pass again (rescan)
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

    // --- VISUAL STYLING ---

    /**
     * Styles by duplicate count: blue at 2 copies, shading to red at 10 or more.
     * Returns null for a count of 1 or less.
     */
    function styleForCount(count) {
        if (count <= 1) return null;

        const maxCount = 10; // Cap at 10 for max redness
        const t = (Math.min(count, maxCount) - 1) / (maxCount - 1); // 0..1
        const hue = 200 - (200 * t);

        // Wider stripes for a low count, tighter for a high one: 20px -> 5px
        const stripeWidth = 20 - (15 * t);
        const colorA = `hsla(${hue}, 100%, 50%, 0.3)`;
        const colorB = `hsla(${hue}, 100%, 50%, 0.05)`;

        return {
            outline: `3px solid hsl(${hue}, 100%, 50%)`,
            outlineOffset: '-4px',
            backgroundImage: `repeating-linear-gradient(45deg, ${colorA}, ${colorA} 2px, ${colorB} 2px, ${colorB} ${stripeWidth}px)`,
            badgeBg: `hsl(${hue}, 100%, 30%)`,
            badgeColor: '#fff',
            zIndex: 1000 + count
        };
    }

    /**
     * Marks an image as one of `count` look-alikes: outline on the image,
     * stripe overlay and count pill on its parent.
     */
    function markDuplicate(img, count) {
        const parent = img.parentElement;
        if (!parent) return;

        // Remove the previous decoration
        const existingCount = parent.querySelector('.dih-count');
        if (existingCount) existingCount.remove();
        const existingStripe = parent.querySelector('.dih-stripe');
        if (existingStripe) existingStripe.remove();

        if (count <= 1) {
            img.style.outline = '';
            return;
        }

        const styles = styleForCount(count);

        img.style.outline = styles.outline;
        img.style.outlineOffset = styles.outlineOffset;

        // The overlay and pill are positioned against the parent
        if (window.getComputedStyle(parent).position === 'static') {
            parent.style.position = 'relative';
        }

        const stripe = document.createElement('div');
        stripe.className = 'dih-stripe';
        Object.assign(stripe.style, {
            position: 'absolute',
            top: '0',
            left: '0',
            width: '100%',
            height: '100%',
            backgroundImage: styles.backgroundImage,
            pointerEvents: 'none',
            zIndex: String(styles.zIndex - 1),
            borderRadius: 'inherit'
        });
        parent.appendChild(stripe);

        const pill = document.createElement('div');
        pill.className = 'dih-count';
        pill.textContent = String(count);
        pill.setAttribute('title', `Duplicate: ${count} copies on this page`);
        Object.assign(pill.style, {
            position: 'absolute',
            top: '4px',
            right: '4px',
            backgroundColor: styles.badgeBg,
            color: styles.badgeColor,
            padding: '2px 6px',
            borderRadius: '12px',
            fontSize: '12px',
            fontWeight: 'bold',
            fontFamily: 'sans-serif',
            zIndex: String(styles.zIndex),
            boxShadow: '0 2px 4px rgba(0,0,0,0.5)',
            pointerEvents: 'none'
        });
        parent.appendChild(pill);
    }

    // --- HASH MATCHING ---

    /**
     * The hash key a new hash belongs to: itself if already stored, otherwise
     * the first stored hash within HAMMING_THRESHOLD bits, otherwise null.
     */
    function findMatchingHash(newHash, hashMap) {
        if (hashMap.has(newHash)) return newHash;

        for (const existingHash of hashMap.keys()) {
            if (DuplicateImageHash.hammingDistance(newHash, existingHash) <= HAMMING_THRESHOLD) {
                return existingHash;
            }
        }
        return null;
    }

    /**
     * Flat placeholders hash to all 0 or all f bits.
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

    // --- MEMORY ---

    // src URL -> hash key
    const processedSrcUrls = new Map();

    // hash key -> Set of src URLs that look like it
    const hashToSrcUrls = new Map();

    // URLs that failed to hash (not retried)
    const failedUrls = new Set();

    /**
     * Evicts the oldest entries from the caches when they exceed their limits.
     */
    function evictOldestEntries() {
        if (processedSrcUrls.size > MAX_CACHE_ENTRIES) {
            let toRemove = processedSrcUrls.size - MAX_CACHE_ENTRIES;
            for (const [src, hash] of processedSrcUrls) {
                if (toRemove-- <= 0) break;
                processedSrcUrls.delete(src);
                const srcSet = hashToSrcUrls.get(hash);
                if (srcSet) {
                    srcSet.delete(src);
                    if (srcSet.size === 0) hashToSrcUrls.delete(hash);
                }
            }
        }

        // Drop the oldest half of the failed URLs
        if (failedUrls.size > MAX_FAILED_ENTRIES) {
            let toRemove = Math.floor(failedUrls.size / 2);
            for (const url of failedUrls) {
                if (toRemove-- <= 0) break;
                failedUrls.delete(url);
            }
        }
    }

    /**
     * Mark every image on the page whose URL shares this hash key.
     */
    function updateAllMatchingImages(targetHash) {
        const matchingSrcs = hashToSrcUrls.get(targetHash);
        if (!matchingSrcs || matchingSrcs.size <= 1) return;

        for (const pageImg of document.querySelectorAll('img')) {
            if (matchingSrcs.has(getImageSrc(pageImg))) {
                markDuplicate(pageImg, matchingSrcs.size);
            }
        }
    }

    /**
     * Re-apply the highlight to an image whose URL is already hashed.
     */
    function remark(img, src) {
        const srcSet = hashToSrcUrls.get(processedSrcUrls.get(src));
        if (srcSet && srcSet.size > 1) markDuplicate(img, srcSet.size);
    }

    // --- PAGE PROCESSING ---

    /**
     * Hash an image that came near the viewport and check it for duplicates.
     */
    function processImage(img) {
        const src = getImageSrc(img);

        if (processedSrcUrls.has(src)) {
            remark(img, src);
            return;
        }
        if (failedUrls.has(src)) return;

        DuplicateImageHash.queueHash(src).then((hash) => {
            if (!hash) {
                failedUrls.add(src);
                return;
            }
            if (isSolidColor(hash)) return;

            const targetKey = findMatchingHash(hash, hashToSrcUrls) || hash;
            processedSrcUrls.set(src, targetKey);
            if (!hashToSrcUrls.has(targetKey)) hashToSrcUrls.set(targetKey, new Set());
            const matchingSrcs = hashToSrcUrls.get(targetKey);
            matchingSrcs.add(src);

            // Different URLs with the same look = duplicates
            if (matchingSrcs.size > 1) {
                console.log(`${LOG_PREFIX} Duplicate found:`, {
                    hash: targetKey.substring(0, 16) + '...',
                    count: matchingSrcs.size
                });
                updateAllMatchingImages(targetKey);
            }
        });
    }

    /**
     * Big enough, and a real URL rather than inline data.
     */
    function isValidImage(img) {
        if (!img.src || img.src.startsWith('data:')) return false;
        return img.naturalWidth > 100 && img.naturalHeight > 50;
    }

    // --- VIEWPORT-BASED PROCESSING ---

    // Images already handed to the IntersectionObserver
    const observedImages = new WeakSet();

    /**
     * Hash images as they approach the viewport, starting 500px before they
     * become visible.
     */
    const imageObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const img = entry.target;
            imageObserver.unobserve(img);
            if (isValidImage(img)) processImage(img);
        }
    }, {
        rootMargin: '500px',
        threshold: 0
    });

    /**
     * The observe pass: watch every image not yet watched, and re-apply the
     * highlight to images whose URL is already known.
     */
    function observeNewImages() {
        evictOldestEntries();

        for (const img of document.querySelectorAll('img')) {
            if (observedImages.has(img)) continue;

            const src = getImageSrc(img);
            if (processedSrcUrls.has(src)) {
                remark(img, src);
                continue;
            }
            if (failedUrls.has(src)) continue;

            observedImages.add(img);
            imageObserver.observe(img);
        }
    }

    // --- KEYBOARD SHORTCUTS ---

    window.addEventListener('keydown', (e) => {
        if (!e.altKey || !e.shiftKey) return;

        // Alt + Shift + R = forget everything and reload
        if (e.code === 'KeyR') {
            console.log(`${LOG_PREFIX} Resetting...`);
            processedSrcUrls.clear();
            hashToSrcUrls.clear();
            failedUrls.clear();
            location.reload();
        }

        // Alt + Shift + D = debug dump
        if (e.code === 'KeyD') {
            console.log(`${LOG_PREFIX} Debug dump`);
            console.log('Processed URLs:', processedSrcUrls.size);
            console.log('Unique hashes:', hashToSrcUrls.size);
            console.log('Failed URLs:', failedUrls.size);

            const duplicates = [];
            for (const [hash, srcSet] of hashToSrcUrls) {
                if (srcSet.size > 1) {
                    duplicates.push({
                        hash: hash.substring(0, 16) + '...',
                        count: srcSet.size,
                        urls: Array.from(srcSet).map(u => u.substring(0, 60) + '...')
                    });
                }
            }
            console.table(duplicates);
        }

        // Alt + Shift + S = rescan now
        if (e.code === 'KeyS') {
            console.log(`${LOG_PREFIX} Manual rescan triggered`);
            observeNewImages();
        }
    });

    // --- PAGE CHANGES (infinite scroll, SPAs) ---

    let debounceTimer = null;
    const domObserver = new MutationObserver(() => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(observeNewImages, 500);
    });
    domObserver.observe(document.body, { childList: true, subtree: true });

    window.__duplicateImageHighlighter = {
        rescan: observeNewImages,
        // Exposed for tests
        markDuplicate
    };

    console.log(`${LOG_PREFIX} Active on this tab.`);
    setTimeout(observeNewImages, 500);
})();
