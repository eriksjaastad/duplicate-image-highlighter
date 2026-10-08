/**
 * Content script. Nothing runs until you click the toolbar button: the click
 * injects hash.js and then this file into the clicked tab's top frame only
 * (no iframes). Clicking again runs the observe pass again (a rescan); it does
 * not add a second observer or a second set of shortcuts. Why top frame only:
 * each frame is its own script instance, so comparing across frames would need
 * a per-tab collector in the service worker, and injecting into every frame
 * means running inside every advert and embed. Galleries keep their images in
 * the top document.
 *
 * What counts as a duplicate:
 * - Two different image URLs whose 32x32 difference hashes (992 bits) are
 *   within Hamming distance 5 (HAMMING_THRESHOLD). The same URL twice is not
 *   a duplicate.
 * - A new hash joins the first stored hash within 5 bits, in the order
 *   hashes arrive. Matches do not chain: A~B and B~C does not put A with C.
 *   This is the original plugin's rule, kept on purpose, order dependence
 *   included.
 * - Skipped: images with no src, data: URLs, and images whose natural size
 *   is not greater than 100x50 (naturalWidth > 100 and naturalHeight > 50).
 * - Skipped: hashes that are all 0 or all f (flat placeholders).
 *
 * When to look:
 * - Images are hashed when they come within 500px of the viewport
 *   (IntersectionObserver, rootMargin 500px), at most 5 at a time.
 * - DOM changes under document.body trigger the observe pass 500ms after
 *   they stop; adding or removing our own stripe and pill does not. The first
 *   pass runs 500ms after the click.
 * - A URL that failed to hash is not retried until Alt+Shift+R.
 * - A URL is hashed once at a time: other images showing it while its hash
 *   is in flight wait for that result instead of queueing it again. One whose
 *   src has changed by the time it finishes is not marked (nor hashed again).
 * - An image removed from the page before it came near the viewport is no
 *   longer watched.
 *
 * Limits, kept from the original:
 * - An image that came near the viewport before its pixels decoded is never
 *   watched again: there is no load listener, and a changed src is not hashed.
 * - Counts never shrink: removing an image from the page leaves the count and
 *   pill on the images that remain.
 *
 * What you see on each image whose look-alike group has N > 1 URLs:
 * - with t = (min(N, 10) - 1) / 9, hue = 200 - 200 * t (blue at 2, red at 10+)
 * - a 3px solid outline in that hue, offset -4px, on the image
 * - div.dih-stripe: a striped overlay covering the image's parent, with
 *   45deg stripes 20 - 15 * t pixels wide
 * - div.dih-count: a pill in the parent's top-right corner showing N
 * A parent with position static is made position relative to hold them.
 * Only the parent's direct-child stripe and pill belong to its image; one that
 * already shows N, on an image whose outline already matches, is left alone,
 * so re-marking does not change the page and trigger another pass.
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

    const HAMMING_THRESHOLD = 5;

    // Caps on the maps, for infinite-scroll pages; the oldest entries go first.
    const MAX_CACHE_ENTRIES = 5000;
    const MAX_FAILED_ENTRIES = 1000;

    /**
     * Inline styles for a duplicate count (always > 1): the image's outline,
     * the parent's stripe overlay and its count pill. Blue at 2 copies,
     * shading to red at 10 or more, with stripes narrowing from 20px to 5px.
     */
    function decorationStyles(count) {
        const t = (Math.min(count, 10) - 1) / 9;
        const hue = 200 - (200 * t);
        const stripeWidth = 20 - (15 * t);
        const colorA = `hsla(${hue}, 100%, 50%, 0.3)`;
        const colorB = `hsla(${hue}, 100%, 50%, 0.05)`;

        return {
            outline: {
                outline: `3px solid hsl(${hue}, 100%, 50%)`,
                outlineOffset: '-4px'
            },
            stripe: {
                position: 'absolute',
                top: '0',
                left: '0',
                width: '100%',
                height: '100%',
                backgroundImage: `repeating-linear-gradient(45deg, ${colorA}, ${colorA} 2px, ${colorB} 2px, ${colorB} ${stripeWidth}px)`,
                pointerEvents: 'none',
                zIndex: String(1000 + count - 1),
                borderRadius: 'inherit'
            },
            pill: {
                position: 'absolute',
                top: '4px',
                right: '4px',
                backgroundColor: `hsl(${hue}, 100%, 30%)`,
                color: '#fff',
                padding: '2px 6px',
                borderRadius: '12px',
                fontSize: '12px',
                fontWeight: 'bold',
                fontFamily: 'sans-serif',
                zIndex: String(1000 + count),
                boxShadow: '0 2px 4px rgba(0,0,0,0.5)',
                pointerEvents: 'none'
            }
        };
    }

    /**
     * The parent's direct child with this class (a nested image's decoration
     * belongs to that image, not this one).
     */
    function decorationOf(parent, className) {
        return parent.querySelector(`:scope > .${className}`);
    }

    /**
     * Whether every listed inline style on `el` already reads back as `styles`
     * would. The browser re-serializes what it is given (hsl becomes rgb), so
     * both sides go through a scratch element first.
     */
    function hasStyles(el, styles) {
        const probe = document.createElement('div');
        Object.assign(probe.style, styles);
        return Object.keys(styles).every((name) => el.style[name] === probe.style[name]);
    }

    /**
     * Marks an image as one of `count` look-alikes: outline on the image,
     * stripe overlay and count pill on its parent. Leaves whatever already
     * matches untouched, so a repeat call changes nothing.
     */
    function markDuplicate(img, count) {
        const parent = img.parentElement;
        if (!parent) return;

        const styles = decorationStyles(count);
        if (!hasStyles(img, styles.outline)) Object.assign(img.style, styles.outline);

        if (window.getComputedStyle(parent).position === 'static') {
            parent.style.position = 'relative';
        }

        const existingStripe = decorationOf(parent, 'dih-stripe');
        const existingCount = decorationOf(parent, 'dih-count');
        const title = `Duplicate: ${count} copies on this page`;
        if (existingStripe && existingCount &&
            existingCount.textContent === String(count) &&
            existingCount.getAttribute('title') === title &&
            hasStyles(existingStripe, styles.stripe) &&
            hasStyles(existingCount, styles.pill)) {
            return;
        }

        existingCount?.remove();
        existingStripe?.remove();

        const stripe = document.createElement('div');
        stripe.className = 'dih-stripe';
        Object.assign(stripe.style, styles.stripe);
        parent.appendChild(stripe);

        const pill = document.createElement('div');
        pill.className = 'dih-count';
        pill.textContent = String(count);
        pill.setAttribute('title', title);
        Object.assign(pill.style, styles.pill);
        parent.appendChild(pill);
    }

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

    // Flat placeholders hash to all 0 or all f bits.
    function isSolidColor(hash) {
        return /^(0+|f+)$/.test(hash);
    }

    // currentSrc covers responsive images (srcset).
    function getImageSrc(img) {
        return img.currentSrc || img.src;
    }

    // src URL -> hash key
    const processedSrcUrls = new Map();

    // hash key -> Set of src URLs that look like it
    const hashToSrcUrls = new Map();

    // URLs that failed to hash (not retried)
    const failedUrls = new Set();

    // src URL -> its hash in flight; cleared when it finishes
    const pendingHashes = new Map();

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

    /**
     * Whether this URL needs no hashing: an image showing a URL already
     * hashed is re-marked; one showing a URL that failed is left alone.
     */
    function alreadyHandled(img, src) {
        if (processedSrcUrls.has(src)) {
            remark(img, src);
            return true;
        }
        return failedUrls.has(src);
    }

    /**
     * Hash an image that came near the viewport and check it for duplicates.
     */
    function processImage(img) {
        const src = getImageSrc(img);
        if (alreadyHandled(img, src)) return;

        // Another image with this URL is already being hashed: share its result
        const pending = pendingHashes.get(src);
        if (pending) {
            // Unless this image has since moved on to another URL
            pending.then(() => {
                if (getImageSrc(img) === src) remark(img, src);
            });
            return;
        }

        pendingHashes.set(src, DuplicateImageHash.queueHash(src).then((hash) => {
            pendingHashes.delete(src);
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
        }));
    }

    /**
     * Big enough, and a real URL rather than inline data.
     */
    function isValidImage(img) {
        if (!img.src || img.src.startsWith('data:')) return false;
        return img.naturalWidth > 100 && img.naturalHeight > 50;
    }

    // Images already handed to the IntersectionObserver
    const observedImages = new WeakSet();

    // The subset still waiting to come near the viewport
    const watchingImages = new Set();

    const imageObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const img = entry.target;
            imageObserver.unobserve(img);
            watchingImages.delete(img);
            if (isValidImage(img)) processImage(img);
        }
    }, {
        rootMargin: '500px',
        threshold: 0
    });

    /**
     * The observe pass: stop watching images that left the page before they
     * came into view, watch every image not yet watched, and re-apply the
     * highlight to images whose URL is already known.
     */
    function observeNewImages() {
        evictOldestEntries();

        for (const img of watchingImages) {
            if (img.isConnected) continue;
            imageObserver.unobserve(img);
            watchingImages.delete(img);
            observedImages.delete(img);
        }

        for (const img of document.querySelectorAll('img')) {
            if (observedImages.has(img)) continue;
            if (alreadyHandled(img, getImageSrc(img))) continue;

            observedImages.add(img);
            watchingImages.add(img);
            imageObserver.observe(img);
        }
    }

    window.addEventListener('keydown', (e) => {
        if (!e.altKey || !e.shiftKey) return;

        if (e.code === 'KeyR') {
            console.log(`${LOG_PREFIX} Resetting...`);
            processedSrcUrls.clear();
            hashToSrcUrls.clear();
            failedUrls.clear();
            location.reload();
        }

        if (e.code === 'KeyD') {
            console.log(`${LOG_PREFIX} Debug dump`);
            console.log('Processed URLs:', processedSrcUrls.size);
            console.log('Unique hashes:', hashToSrcUrls.size);
            console.log('Failed URLs:', failedUrls.size);

            const duplicates = [...hashToSrcUrls]
                .filter(([, srcSet]) => srcSet.size > 1)
                .map(([hash, srcSet]) => ({
                    hash: hash.substring(0, 16) + '...',
                    count: srcSet.size,
                    urls: Array.from(srcSet).map(u => u.substring(0, 60) + '...')
                }));
            console.table(duplicates);
        }

        if (e.code === 'KeyS') {
            console.log(`${LOG_PREFIX} Manual rescan triggered`);
            observeNewImages();
        }
    });

    /**
     * A change that only adds or removes our own stripes and pills. Two images
     * sharing a parent with different counts swap them on every pass, so
     * counting these as page changes would rescan forever.
     */
    function isOwnDecorationChange(mutation) {
        const nodes = [...mutation.addedNodes, ...mutation.removedNodes];
        return nodes.length > 0 && nodes.every((node) =>
            node.classList?.contains('dih-stripe') || node.classList?.contains('dih-count'));
    }

    // Infinite scroll and single-page apps add images after the first pass.
    let debounceTimer = null;
    const domObserver = new MutationObserver((mutations) => {
        if (mutations.every(isOwnDecorationChange)) return;
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
