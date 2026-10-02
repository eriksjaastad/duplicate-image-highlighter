/**
 * Perceptual hashing module (dHash), exposed as window.DuplicateImageHash.
 *
 * Uses the "difference hash" algorithm:
 * 1. Resize the image to a small square (32x32)
 * 2. Compare the brightness of horizontally adjacent pixels
 * 3. Emit one bit per comparison
 *
 * The hash is resilient to:
 * - Image resizing
 * - Minor color adjustments
 * - Compression artifacts
 */
(function () {
    // Clicking the toolbar button again re-injects this file; keep the first instance.
    if (window.DuplicateImageHash) return;

    // --- CONFIG ---

    /**
     * Target size for image resizing before hashing.
     * 32x32 provides a good balance of accuracy vs performance.
     * Produces a 32x31 = 992 bit hash (248 hex characters).
     */
    const TARGET_SIZE = 32;

    /**
     * Maximum concurrent hash operations.
     * Stays under the browser's ~6 concurrent connections per origin.
     */
    const MAX_CONCURRENT = 5;

    // Reuse a single canvas to save memory
    const canvas = document.createElement('canvas');
    canvas.width = TARGET_SIZE;
    canvas.height = TARGET_SIZE;
    // Optimize for pixel reading
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    // Queue system
    const queue = [];
    let activeCount = 0;

    /**
     * Enqueues a request to hash an image URL.
     * Returns a Promise that resolves to { hash, solid }, null on failure, or
     * { dropped: true } if dropQueued() removed it before it started.
     */
    function queueHash(url) {
        return new Promise((resolve) => {
            queue.push({ url, resolve });
            processQueue();
        });
    }

    /**
     * Drop queued (not yet started) hashes whose URL `isUnwanted(url)` says
     * are no longer needed; their promises resolve to { dropped: true }.
     * Hashes already in flight finish normally.
     */
    function dropQueued(isUnwanted) {
        for (let i = queue.length - 1; i >= 0; i--) {
            if (!isUnwanted(queue[i].url)) continue;
            const [task] = queue.splice(i, 1);
            task.resolve({ dropped: true });
        }
    }

    /**
     * Number of hashes queued or in flight.
     */
    function pendingCount() {
        return queue.length + activeCount;
    }

    function processQueue() {
        // Process up to MAX_CONCURRENT items simultaneously
        while (activeCount < MAX_CONCURRENT && queue.length > 0) {
            activeCount++;
            const task = queue.shift();

            computeHashInternal(task.url)
                .then(hash => task.resolve(hash))
                .catch(err => {
                    console.warn('[DuplicateImageHighlighter] Hash failed:', err);
                    task.resolve(null);
                })
                .finally(() => {
                    activeCount--;
                    processQueue(); // Fill the freed slot
                });
        }
    }

    /**
     * Steps:
     * 1. Ask the service worker to fetch the image (cross-origin pixels).
     * 2. Decode the bytes (createImageBitmap on a Blob; SVG via the data URL).
     * 3. Draw it onto the 32x32 canvas, over white.
     * 4. Compute the dHash, and whether the image is one flat color.
     */
    async function computeHashInternal(url) {
        const dataUrl = await fetchImageViaBackground(url);
        if (!dataUrl) return null;

        const img = await decodeImage(dataUrl);

        // Composite onto white: transparent pixels would otherwise read as
        // black (0, 0, 0, 0), hiding a shape drawn on a transparent background.
        try {
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, TARGET_SIZE, TARGET_SIZE);
            ctx.drawImage(img, 0, 0, TARGET_SIZE, TARGET_SIZE);
        } finally {
            if (img.close) img.close(); // ImageBitmap: free the decoded pixels now
        }

        const pixels = ctx.getImageData(0, 0, TARGET_SIZE, TARGET_SIZE).data; // RGBA
        return { hash: dHashFromPixels(pixels, TARGET_SIZE), solid: isSolidFromPixels(pixels) };
    }

    /**
     * Per-channel standard deviation below which an image counts as one flat
     * color (a placeholder). Re-encoding noise stays well under it; any visible
     * pattern or gradient is far above it.
     */
    const SOLID_MAX_STDDEV = 2;

    /**
     * True when every pixel in the RGBA buffer has nearly the same color and
     * opacity. Hashed images are drawn over white, so their alpha is always
     * flat by the time they get here; checking it keeps this function correct
     * for any RGBA buffer, not only composited ones.
     * The hash alone cannot tell: a smooth left-to-right gradient also hashes
     * to all zero (or all one) bits. Each channel is checked on its own, since
     * a pattern of different colors can have one brightness throughout.
     */
    function isSolidFromPixels(pixels) {
        const count = pixels.length / 4;
        for (let channel = 0; channel < 4; channel++) {
            let sum = 0;
            let sumSquares = 0;
            for (let i = channel; i < pixels.length; i += 4) {
                sum += pixels[i];
                sumSquares += pixels[i] * pixels[i];
            }
            const mean = sum / count;
            if (sumSquares / count - mean * mean >= SOLID_MAX_STDDEV * SOLID_MAX_STDDEV) return false;
        }
        return true;
    }

    /**
     * Difference hash over a size x size RGBA pixel buffer, row by row.
     * Each bit is 1 when a pixel is brighter than its right-hand neighbour.
     */
    function dHashFromPixels(pixels, size) {
        let bits = '';

        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size - 1; x++) {
                const iA = (y * size + x) * 4;
                const bA = (pixels[iA] + pixels[iA + 1] + pixels[iA + 2]) / 3;

                const iB = (y * size + (x + 1)) * 4;
                const bB = (pixels[iB] + pixels[iB + 1] + pixels[iB + 2]) / 3;

                bits += (bA > bB) ? '1' : '0';
            }
        }

        return binToHex(bits);
    }

    function fetchImageViaBackground(url) {
        return new Promise((resolve) => {
            chrome.runtime.sendMessage({ action: 'FETCH_IMAGE_BLOB', url: url }, (response) => {
                if (chrome.runtime.lastError || !response || !response.success) {
                    resolve(null);
                } else {
                    resolve(response.dataUrl);
                }
            });
        });
    }

    /**
     * Decode image bytes without loading a URL into the page: a page whose
     * Content-Security-Policy leaves `data:` out of img-src blocks
     * `new Image()` with a data URL, but not createImageBitmap on a Blob.
     * Formats createImageBitmap cannot decode (SVG) fall back to the data URL.
     */
    async function decodeImage(dataUrl) {
        try {
            return await createImageBitmap(dataUrlToBlob(dataUrl));
        } catch (bitmapErr) {
            // Not decodable as a bitmap (SVG): try the data URL. If that fails
            // too, report both causes; an Image error event carries no message.
            try {
                return await loadImage(dataUrl);
            } catch (imageErr) {
                throw new Error(`could not decode image (as a bitmap: ${describeError(bitmapErr)}; ` +
                    `as an Image: ${describeError(imageErr)})`);
            }
        }
    }

    function describeError(err) {
        if (err && err.message) return err.message;
        if (err && err.type) return `${err.type} event`;
        return String(err);
    }

    // Base64 data URL -> Blob, without fetch(), which a page's connect-src could block.
    function dataUrlToBlob(dataUrl) {
        const comma = dataUrl.indexOf(',');
        const header = dataUrl.slice(5, comma); // after 'data:'
        const type = header.split(';')[0];
        const binary = atob(dataUrl.slice(comma + 1));
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return new Blob([bytes], { type });
    }

    function loadImage(src) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = src;
        });
    }

    /**
     * Converts a binary string to hexadecimal.
     * A final chunk shorter than 4 bits is right-padded with '0' bits.
     */
    function binToHex(bin) {
        let hex = '';
        for (let i = 0; i < bin.length; i += 4) {
            const chunk = bin.slice(i, i + 4).padEnd(4, '0');
            hex += parseInt(chunk, 2).toString(16);
        }
        return hex;
    }

    /**
     * Hamming distance between two hex hash strings.
     * Returns Infinity when either is missing or the lengths differ.
     * With a limit, stops counting as soon as the distance exceeds it and
     * returns that partial count (still > limit).
     */
    function hammingDistance(h1, h2, limit = Infinity) {
        if (!h1 || !h2 || h1.length !== h2.length) return Infinity;

        let distance = 0;
        for (let i = 0; i < h1.length; i++) {
            let mask = (parseInt(h1[i], 16) ^ parseInt(h2[i], 16)) || 0;
            while (mask) {
                distance += mask & 1;
                mask >>= 1;
            }
            if (distance > limit) return distance;
        }
        return distance;
    }

    window.DuplicateImageHash = {
        queueHash,
        dropQueued,
        pendingCount,
        hammingDistance,
        // Exposed for tests
        binToHex,
        dHashFromPixels,
        isSolidFromPixels
    };
})();
