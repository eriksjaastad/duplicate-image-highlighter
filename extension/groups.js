/**
 * Duplicate grouping, exposed as window.DuplicateImageGroups. No DOM access:
 * content.js tells it which elements show which image URLs, and it works out
 * which of those URLs look alike.
 *
 * - Elements: the img elements currently on the page and the URL each shows,
 *   replaced wholesale on every page scan, so removed images and changed srcs
 *   drop out.
 * - Cache: URL -> hash (or "skip" for solid-color and too-small images).
 *   Trimmed on every sync; URLs still shown on the page are never evicted.
 * - Groups: connected components of the URLs on the page, where two URLs are
 *   connected when their hashes differ by at most `threshold` bits. A~B and
 *   B~C put A, B and C in one group whatever order they were hashed in.
 *
 * No pairwise links are stored. Each hash's bits are dealt into threshold + 1
 * bands (bit p goes to band p mod bands): two hashes within `threshold` bits
 * must agree exactly on at least one band (pigeonhole), so a band index finds
 * every possible match. Dealing the bits, rather than cutting the hash into
 * runs, spreads each band over the whole picture: images that merely share a
 * flat background (identical rows of the hash) do not share a band. The
 * union-find over images on the page is kept between calls and extended as
 * hashes arrive; when an image leaves, only the group it was in is rebuilt.
 */
(function () {
    // Clicking the toolbar button again re-injects this file; keep the first instance.
    if (window.DuplicateImageGroups) return;

    /**
     * @param {object} options
     * @param {number} options.threshold - max differing bits for two hex hashes to match
     * @param {number} options.maxCacheEntries - cache size before evicting URLs no longer on the page
     * @param {number} options.maxFailedEntries - failed URLs remembered before forgetting the oldest half
     */
    function createTracker({ threshold, maxCacheEntries, maxFailedEntries }) {
        // element -> URL it shows, as of the last sync()
        let elements = new Map();
        // URLs shown by at least one element, as of the last sync()
        let liveSrcs = new Set();

        // URL -> { node } for a hashed image, or { skip: true } for one never compared
        const cache = new Map();
        // hash -> { hash, words: the hash as 32-bit words, srcs: Set of cached URLs
        //          with this exact hash, bands: band keys }
        const nodes = new Map();
        // band key -> Set of nodes with that band
        const bandIndex = new Map();
        const bandCount = threshold + 1;
        // Union-find over hash nodes on the page. A member node has
        // `joined` set, `up` (its parent), and, while it is a root,
        // `group` (every member of its group).
        const members = new Set();
        // Hash comparisons made so far (stats, tests)
        let comparisons = 0;
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
            evict();
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
         * A pending hash was abandoned before it ran: the URL can be queued again.
         */
        function cancelPending(src) {
            pending.delete(src);
        }

        /**
         * True when an element showed this URL at the last sync().
         */
        function isLive(src) {
            return liveSrcs.has(src);
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
        }

        /**
         * Remember a URL that must not be compared (solid color, too small).
         */
        function recordSkip(src) {
            forget(src);
            cache.set(src, { skip: true });
        }

        function retryFailed() {
            failed.clear();
        }

        function nodeFor(hash, src) {
            let node = nodes.get(hash);
            if (!node) {
                node = { hash, words: wordsOf(hash), srcs: new Set(), bands: bandsOf(hash), joined: false, up: null, group: null };
                for (const band of node.bands) {
                    if (!bandIndex.has(band)) bandIndex.set(band, new Set());
                    bandIndex.get(band).add(node);
                }
                nodes.set(hash, node);
            }
            node.srcs.add(src);
            return node;
        }

        // Band keys: bit p of the hash goes to band p mod bandCount; each band's
        // bits are packed back into hex.
        function bandsOf(hash) {
            const bits = [];
            for (let i = 0; i < bandCount; i++) bits.push([]);
            for (let c = 0; c < hash.length; c++) {
                const nibble = parseInt(hash[c], 16);
                for (let k = 0; k < 4; k++) {
                    const p = c * 4 + k;
                    bits[p % bandCount].push((nibble >> (3 - k)) & 1);
                }
            }
            return bits.map((band, i) => {
                let hex = '';
                for (let j = 0; j < band.length; j += 4) {
                    hex += ((band[j] << 3) | ((band[j + 1] || 0) << 2) | ((band[j + 2] || 0) << 1) | (band[j + 3] || 0)).toString(16);
                }
                return `${i}:${hex}`;
            });
        }

        function wordsOf(hash) {
            const words = new Uint32Array(Math.ceil(hash.length / 8));
            for (let i = 0; i < words.length; i++) {
                words[i] = parseInt(hash.slice(i * 8, i * 8 + 8).padEnd(8, '0'), 16);
            }
            return words;
        }

        // Differing bits between two nodes' hashes; stops counting once past
        // `limit`. Hashes of different lengths never match.
        function distance(a, b, limit) {
            comparisons++;
            if (a.hash.length !== b.hash.length) return Infinity;
            let d = 0;
            for (let i = 0; i < a.words.length; i++) {
                let x = a.words[i] ^ b.words[i];
                x -= (x >>> 1) & 0x55555555;
                x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
                d += (Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24);
                if (d > limit) return d;
            }
            return d;
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
            for (const band of node.bands) {
                const inBand = bandIndex.get(band);
                inBand.delete(node);
                if (inBand.size === 0) bandIndex.delete(band);
            }
            nodes.delete(node.hash);
            // Left in `members` on purpose: groups() sees a node that is not on
            // the page and takes its group apart, so nothing still points at it.
        }

        // Evict the oldest URLs no longer on the page until the cache fits.
        // Runs on sync(), when the set of URLs on the page is fresh.
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

            // A match through an image that has left the page does not count:
            // take apart each group that lost a member, then add back its
            // members still on the page along with any new ones.
            for (const node of [...members]) {
                if (node.joined && !liveByNode.has(node)) leaveUnion(node);
            }
            for (const node of liveByNode.keys()) {
                if (!node.joined) addToUnion(node);
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

        function find(node) {
            while (node.up !== node) {
                node.up = node.up.up;
                node = node.up;
            }
            return node;
        }

        // Join a node to every node on the page that shares a band with it and
        // is within the threshold, skipping ones already in its group.
        function addToUnion(node) {
            node.joined = true;
            node.up = node;
            node.group = [node];
            members.add(node);
            for (const band of node.bands) {
                for (const other of bandIndex.get(band)) {
                    if (other === node || !other.joined) continue;
                    const a = find(node);
                    const b = find(other);
                    if (a === b) continue;
                    if (distance(node, other, threshold) <= threshold) merge(a, b);
                }
            }
        }

        // Join two roots, the smaller group under the larger.
        function merge(a, b) {
            const [small, large] = a.group.length <= b.group.length ? [a, b] : [b, a];
            small.up = large;
            for (const node of small.group) large.group.push(node);
            small.group = null;
        }

        // Take apart the group containing `node`; its members are re-added by
        // groups() if they are still on the page.
        function leaveUnion(node) {
            for (const member of find(node).group) {
                member.joined = false;
                member.up = null;
                member.group = null;
                members.delete(member);
            }
        }

        function stats() {
            return { cached: cache.size, hashes: nodes.size, bands: bandIndex.size, comparisons, pending: pending.size, failed: failed.size };
        }

        return { sync, entries, isLive, needsHash, markPending, cancelPending, recordHash, recordSkip, retryFailed, groups, stats };
    }

    window.DuplicateImageGroups = { createTracker };
})();
