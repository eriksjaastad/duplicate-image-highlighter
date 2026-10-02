/**
 * Duplicate grouping, exposed as window.DuplicateImageGroups. No DOM access:
 * content.js tells it which elements show which image URLs, and it works out
 * which of those URLs look alike.
 *
 * - Elements: the img elements currently on the page and the URL each shows,
 *   replaced wholesale on every page scan, so removed images and changed srcs
 *   drop out.
 * - Cache: URL -> hash (or "skip" for solid-color and too-small images).
 *   Bounded; URLs still shown on the page are never evicted.
 * - Groups: connected components of the URLs on the page, where two URLs are
 *   connected when their hashes differ by at most `threshold` bits. A~B and
 *   B~C put A, B and C in one group whatever order they were hashed in.
 */
(function () {
    // Clicking the toolbar button again re-injects this file; keep the first instance.
    if (window.DuplicateImageGroups) return;

    /**
     * @param {object} options
     * @param {number} options.threshold - max differing bits for two hashes to match
     * @param {function} options.distance - (hashA, hashB, limit) -> differing bits
     * @param {number} options.maxCacheEntries - cache size before evicting URLs no longer on the page
     * @param {number} options.maxFailedEntries - failed URLs remembered before forgetting the oldest half
     */
    function createTracker({ threshold, distance, maxCacheEntries, maxFailedEntries }) {
        // element -> URL it shows, as of the last sync()
        let elements = new Map();
        // URLs shown by at least one element, as of the last sync()
        let liveSrcs = new Set();

        // URL -> { node } for a hashed image, or { skip: true } for one never compared
        const cache = new Map();
        // hash -> { srcs: Set of cached URLs with this exact hash, neighbors: Set of nodes within threshold }
        const nodes = new Map();
        // URLs being hashed now
        const pending = new Set();
        // URLs that failed to hash, oldest first (a rescan retries them)
        const failed = new Set();

        /**
         * Replace the set of elements on the page. `entries` is an iterable of
         * [element, url] pairs.
         */
        function sync(entries) {
            elements = new Map(entries);
            liveSrcs = new Set(elements.values());
        }

        function entries() {
            return elements.entries();
        }

        /**
         * True when nothing is known about this URL and it is not being hashed.
         */
        function needsHash(src) {
            return !cache.has(src) && !pending.has(src) && !failed.has(src);
        }

        function markPending(src) {
            pending.add(src);
        }

        /**
         * Record the outcome of hashing a URL: { hash, solid } or null on failure.
         */
        function recordHash(src, result) {
            pending.delete(src);
            if (!result) {
                failed.add(src);
                trimFailed();
                return;
            }
            if (result.solid) {
                recordSkip(src);
                return;
            }
            forget(src);
            cache.set(src, { node: nodeFor(result.hash, src) });
            evict();
        }

        /**
         * Remember a URL that must not be compared (solid color, too small).
         */
        function recordSkip(src) {
            forget(src);
            cache.set(src, { skip: true });
            evict();
        }

        function retryFailed() {
            failed.clear();
        }

        function nodeFor(hash, src) {
            let node = nodes.get(hash);
            if (!node) {
                node = { hash, srcs: new Set(), neighbors: new Set() };
                for (const other of nodes.values()) {
                    if (distance(hash, other.hash, threshold) <= threshold) {
                        node.neighbors.add(other);
                        other.neighbors.add(node);
                    }
                }
                nodes.set(hash, node);
            }
            node.srcs.add(src);
            return node;
        }

        // Drop a URL from the cache, and its hash node once no URL uses it.
        function forget(src) {
            const entry = cache.get(src);
            if (!entry) return;
            cache.delete(src);
            if (!entry.node) return;
            const node = entry.node;
            node.srcs.delete(src);
            if (node.srcs.size > 0) return;
            for (const other of node.neighbors) other.neighbors.delete(node);
            nodes.delete(node.hash);
        }

        // Evict the oldest URLs no longer on the page until the cache fits.
        function evict() {
            if (cache.size <= maxCacheEntries) return;
            for (const src of cache.keys()) {
                if (cache.size <= maxCacheEntries) break;
                if (!liveSrcs.has(src)) forget(src);
            }
        }

        function trimFailed() {
            if (failed.size <= maxFailedEntries) return;
            let toRemove = Math.floor(failed.size / 2);
            for (const src of failed) {
                if (toRemove-- <= 0) break;
                failed.delete(src);
            }
        }

        /**
         * Duplicate groups among the URLs currently on the page.
         * Returns { groups: [Set of URLs], sizeBySrc: Map URL -> group size },
         * listing only groups of two or more different URLs.
         */
        function groups() {
            // hash node -> URLs on the page with that exact hash
            const liveByNode = new Map();
            for (const src of liveSrcs) {
                const node = cache.get(src)?.node;
                if (!node) continue;
                if (!liveByNode.has(node)) liveByNode.set(node, new Set());
                liveByNode.get(node).add(src);
            }

            // Union-find over hash nodes on the page; a match through an image
            // that has left the page does not count.
            const parent = new Map();
            for (const node of liveByNode.keys()) parent.set(node, node);
            function find(node) {
                while (parent.get(node) !== node) {
                    parent.set(node, parent.get(parent.get(node)));
                    node = parent.get(node);
                }
                return node;
            }
            for (const node of liveByNode.keys()) {
                for (const other of node.neighbors) {
                    if (!parent.has(other)) continue;
                    const a = find(node);
                    const b = find(other);
                    if (a !== b) parent.set(a, b);
                }
            }

            const byRoot = new Map();
            for (const [node, srcs] of liveByNode) {
                const root = find(node);
                if (!byRoot.has(root)) byRoot.set(root, new Set());
                for (const src of srcs) byRoot.get(root).add(src);
            }

            const result = { groups: [], sizeBySrc: new Map() };
            for (const srcs of byRoot.values()) {
                if (srcs.size < 2) continue;
                result.groups.push(srcs);
                for (const src of srcs) result.sizeBySrc.set(src, srcs.size);
            }
            return result;
        }

        function stats() {
            let links = 0;
            for (const node of nodes.values()) links += node.neighbors.size;
            return { cached: cache.size, hashes: nodes.size, links: links / 2, pending: pending.size, failed: failed.size };
        }

        return { sync, entries, needsHash, markPending, recordHash, recordSkip, retryFailed, groups, stats };
    }

    window.DuplicateImageGroups = { createTracker };
})();
