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
     * Returns a Promise that resolves to the hex hash string, or null on failure.
     */
    function queueHash(url) {
        return new Promise((resolve) => {
            queue.push({ url, resolve });
            processQueue();
        });
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
     * 2. Decode it.
     * 3. Draw it onto the cleared 32x32 canvas.
     * 4. Compute the dHash.
     */
    async function computeHashInternal(url) {
        const dataUrl = await fetchImageViaBackground(url);
        if (!dataUrl) return null;

        const img = await decodeImage(dataUrl);

        try {
            ctx.clearRect(0, 0, TARGET_SIZE, TARGET_SIZE);
            ctx.drawImage(img, 0, 0, TARGET_SIZE, TARGET_SIZE);
        } finally {
            if (img.close) img.close(); // ImageBitmap: free the decoded pixels now
        }

        const pixels = ctx.getImageData(0, 0, TARGET_SIZE, TARGET_SIZE).data; // RGBA
        return dHashFromPixels(pixels, TARGET_SIZE);
    }

    /**
     * Difference hash over a size x size RGBA pixel buffer, row by row.
     * Each bit is 1 when a pixel's RGB average is strictly greater than its
     * right-hand neighbour's.
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
     * Why a Blob and createImageBitmap: this script runs inside whatever page
     * the user clicked, and a page whose Content-Security-Policy leaves `data:`
     * out of img-src blocks `new Image()` with a data URL. createImageBitmap on
     * a Blob decodes the same bytes without asking the page. It changes only
     * how the bytes are decoded, never what is drawn: the bitmap goes onto the
     * same cleared canvas as an Image would, with no fill and no matte.
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
     * Converts a binary string to hexadecimal, 4 bits at a time.
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
     * Hamming distance between two hex hash strings: the popcount of the XOR
     * of each pair of hex digits.
     * Returns Infinity when either is missing or the lengths differ.
     */
    function hammingDistance(h1, h2) {
        if (!h1 || !h2 || h1.length !== h2.length) return Infinity;

        let distance = 0;
        for (let i = 0; i < h1.length; i++) {
            let mask = (parseInt(h1[i], 16) ^ parseInt(h2[i], 16)) || 0;
            while (mask) {
                distance += mask & 1;
                mask >>= 1;
            }
        }
        return distance;
    }

    window.DuplicateImageHash = {
        queueHash,
        hammingDistance,
        // Exposed for tests
        binToHex,
        dHashFromPixels
    };
})();
