// Run with: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(file, window) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'extension', file), 'utf8');
    vm.runInNewContext(source, {
        window,
        document: { createElement: () => ({ getContext: () => ({}) }) },
        chrome: {}
    });
}

const window = {};
load('hash.js', window);
load('groups.js', window);
const { hammingDistance } = window.DuplicateImageHash;

const HASH_LENGTH = 248; // 992 bits

// A hash with the given bit positions set and every other bit clear.
function hashWithBits(...bits) {
    const nibbles = new Array(HASH_LENGTH).fill(0);
    for (const bit of bits) nibbles[Math.floor(bit / 4)] |= 8 >> (bit % 4);
    return nibbles.map((n) => n.toString(16)).join('');
}

function tracker(options = {}) {
    return window.DuplicateImageGroups.createTracker({
        threshold: 5,
        maxCacheEntries: 100,
        maxFailedEntries: 100,
        ...options
    });
}

// Sorted lists of URLs, one per group, for order-free comparison.
// (Built in this realm: deepStrictEqual rejects arrays made inside the vm context.)
function groupsOf(t) {
    return Array.from(t.groups().groups, (srcs) => [...srcs].sort()).sort();
}

// Puts one element per URL on the page.
function show(t, ...srcs) {
    t.sync(srcs.map((src, i) => [{ id: i }, src]));
}

// A~B and B~C are 5 bits apart, A~C is 10.
const A = hashWithBits();
const B = hashWithBits(0, 1, 2, 3, 4);
const C = hashWithBits(0, 1, 2, 3, 4, 100, 101, 102, 103, 104);
const FAR = hashWithBits(...Array.from({ length: 200 }, (_, i) => 300 + i));

function permutations(items) {
    if (items.length <= 1) return [items];
    return items.flatMap((item, i) =>
        permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));
}

test('fixtures: A~B and B~C within threshold, A~C beyond it', () => {
    assert.equal(hammingDistance(A, B), 5);
    assert.equal(hammingDistance(B, C), 5);
    assert.equal(hammingDistance(A, C), 10);
});

test('a chain A~B~C is one group whatever order the hashes arrive in', () => {
    const hashes = { a: A, b: B, c: C };
    for (const order of permutations(['a', 'b', 'c'])) {
        const t = tracker();
        show(t, 'a', 'b', 'c');
        for (const src of order) t.recordHash(src, { hash: hashes[src], solid: false });
        assert.deepEqual(groupsOf(t), [['a', 'b', 'c']], `order ${order.join('')}`);
        assert.equal(t.groups().sizeBySrc.get('a'), 3);
    }
});

test('the group splits when the image linking it leaves the page', () => {
    const t = tracker();
    show(t, 'a', 'b', 'c');
    t.recordHash('a', { hash: A, solid: false });
    t.recordHash('b', { hash: B, solid: false });
    t.recordHash('c', { hash: C, solid: false });
    show(t, 'a', 'c');
    assert.deepEqual(groupsOf(t), []);
});

test('the same URL shown twice is not a group', () => {
    const t = tracker();
    t.sync([[{ id: 1 }, 'a'], [{ id: 2 }, 'a']]);
    t.recordHash('a', { hash: A, solid: false });
    assert.deepEqual(groupsOf(t), []);
});

test('different URLs with an identical hash are a group', () => {
    const t = tracker();
    show(t, 'a1', 'a2', 'far');
    t.recordHash('a1', { hash: A, solid: false });
    t.recordHash('a2', { hash: A, solid: false });
    t.recordHash('far', { hash: FAR, solid: false });
    assert.deepEqual(groupsOf(t), [['a1', 'a2']]);
    assert.equal(t.groups().sizeBySrc.get('far'), undefined);
});

test('changing an element src drops the old URL from its group', () => {
    const t = tracker();
    const img = { id: 'changes' };
    t.sync([[img, 'a1'], [{ id: 2 }, 'a2']]);
    t.recordHash('a1', { hash: A, solid: false });
    t.recordHash('a2', { hash: A, solid: false });
    assert.equal(groupsOf(t).length, 1);

    t.sync([[img, 'far'], [{ id: 2 }, 'a2']]);
    t.recordHash('far', { hash: FAR, solid: false });
    assert.deepEqual(groupsOf(t), []);
});

test('a hash that arrives after its image left the page does not form a group', () => {
    const t = tracker();
    show(t, 'a1', 'a2');
    t.markPending('a2');
    t.recordHash('a1', { hash: A, solid: false });
    show(t, 'a1');
    t.recordHash('a2', { hash: A, solid: false });
    assert.deepEqual(groupsOf(t), []);
});

test('entries() lists the elements from the last sync', () => {
    const t = tracker();
    const one = { id: 1 };
    const two = { id: 2 };
    t.sync([[one, 'a'], [two, 'b']]);
    t.sync([[two, 'c']]);
    assert.deepEqual(Array.from(t.entries(), ([el, src]) => [el, src]), [[two, 'c']]);
});

test('eviction keeps URLs still on the page, and they keep grouping', () => {
    const t = tracker({ maxCacheEntries: 3 });
    show(t, 'live1', 'live2');
    t.recordHash('live1', { hash: A, solid: false });
    t.recordHash('live2', { hash: A, solid: false });
    for (let i = 0; i < 5; i++) t.recordHash(`gone${i}`, { hash: hashWithBits(500 + i * 40, 501 + i * 40, 502 + i * 40, 503 + i * 40, 504 + i * 40, 505 + i * 40), solid: false });
    assert.equal(t.stats().cached, 7, 'eviction waits for the next sync');
    show(t, 'live1', 'live2');

    assert.equal(t.stats().cached, 3);
    assert.equal(t.needsHash('live1'), false);
    assert.equal(t.needsHash('live2'), false);
    assert.equal(t.needsHash('gone0'), true, 'oldest off-page URL was evicted');
    assert.deepEqual(groupsOf(t), [['live1', 'live2']]);
});

test('eviction drops a hash node once no URL uses it', () => {
    const t = tracker({ maxCacheEntries: 1 });
    show(t);
    t.recordHash('x', { hash: A, solid: false });
    t.recordHash('y', { hash: FAR, solid: false });
    show(t);
    const { comparisons, ...rest } = t.stats();
    assert.deepEqual(rest, { cached: 1, hashes: 1, bands: 6, pending: 0, failed: 0 });
    // The evicted node must no longer link anything: a later B matches nothing on the page.
    show(t, 'b', 'y');
    t.recordHash('b', { hash: B, solid: false });
    assert.deepEqual(groupsOf(t), []);
});

test('evicting a hash removes it from the band index', () => {
    const t = tracker({ maxCacheEntries: 1 });
    show(t, 'a');
    // one differing bit in each of the six bands (bit p is in band p mod 6): shares no band with A
    t.recordHash('far', { hash: hashWithBits(0, 1, 2, 3, 4, 5), solid: false });
    t.recordHash('a', { hash: A, solid: false });
    assert.equal(t.stats().bands, 12);
    show(t, 'a'); // 'far' is evicted
    const { comparisons, ...rest } = t.stats();
    assert.deepEqual(rest, { cached: 1, hashes: 1, bands: 6, pending: 0, failed: 0 });
});

test('groups are rebuilt correctly after the image joining them is evicted, and rejoin when it returns', () => {
    const t = tracker({ maxCacheEntries: 2 });
    show(t, 'a', 'b', 'c');
    t.recordHash('a', { hash: A, solid: false });
    t.recordHash('b', { hash: B, solid: false });
    t.recordHash('c', { hash: C, solid: false });
    assert.deepEqual(groupsOf(t), [['a', 'b', 'c']]);

    show(t, 'a', 'c'); // b leaves the page and is evicted
    assert.equal(t.needsHash('b'), true);
    assert.deepEqual(groupsOf(t), []);

    show(t, 'a', 'c', 'b2');
    t.recordHash('b2', { hash: B, solid: false });
    assert.deepEqual(groupsOf(t), [['a', 'b2', 'c']]);
});

test('a URL hashed since the last sync survives the next eviction if it is on the page', () => {
    const t = tracker({ maxCacheEntries: 1 });
    show(t, 'old');
    t.recordHash('old', { hash: A, solid: false });
    t.recordHash('new', { hash: FAR, solid: false }); // its element changed src after the last sync
    show(t, 'new');
    assert.equal(t.needsHash('new'), false);
    assert.equal(t.needsHash('old'), true);
});

test('the cache may exceed its limit rather than evict URLs on the page', () => {
    const t = tracker({ maxCacheEntries: 1 });
    show(t, 'a1', 'a2');
    t.recordHash('a1', { hash: A, solid: false });
    t.recordHash('a2', { hash: A, solid: false });
    show(t, 'a1', 'a2');
    assert.equal(t.stats().cached, 2);
    assert.deepEqual(groupsOf(t), [['a1', 'a2']]);
});

test('solid images are remembered but never grouped', () => {
    const t = tracker();
    show(t, 's1', 's2');
    t.recordHash('s1', { hash: A, solid: true });
    t.recordHash('s2', { hash: A, solid: true });
    assert.equal(t.needsHash('s1'), false);
    assert.deepEqual(groupsOf(t), []);
});

test('a gradient (all-zero hash, not solid) still groups', () => {
    const t = tracker();
    show(t, 'g1', 'g2');
    t.recordHash('g1', { hash: '0'.repeat(HASH_LENGTH), solid: false });
    t.recordHash('g2', { hash: '0'.repeat(HASH_LENGTH), solid: false });
    assert.deepEqual(groupsOf(t), [['g1', 'g2']]);
});

test('skipped URLs (too small) are not hashed again and never grouped', () => {
    const t = tracker();
    show(t, 'icon');
    t.recordSkip('icon');
    assert.equal(t.needsHash('icon'), false);
    assert.deepEqual(groupsOf(t), []);
});

test('pending and failed URLs are not queued again until a retry', () => {
    const t = tracker();
    assert.equal(t.needsHash('x'), true);
    t.markPending('x');
    assert.equal(t.needsHash('x'), false);
    t.recordHash('x', null);
    assert.equal(t.needsHash('x'), false);
    assert.equal(t.stats().pending, 0);
    t.retryFailed();
    assert.equal(t.needsHash('x'), true);
});

test('failed URLs are bounded, forgetting the oldest half', () => {
    const t = tracker({ maxFailedEntries: 4 });
    for (let i = 0; i < 5; i++) t.recordHash(`f${i}`, null);
    assert.equal(t.stats().failed, 3);
    assert.equal(t.needsHash('f0'), true);
    assert.equal(t.needsHash('f1'), true);
    assert.equal(t.needsHash('f4'), false);
});

test('re-injecting the module keeps the first instance', () => {
    const first = { marker: true };
    const win = { DuplicateImageGroups: first };
    load('groups.js', win);
    assert.equal(win.DuplicateImageGroups, first);
});

// Deterministic pseudo-random numbers in [0, 1) (mulberry32).
function seededRandom(seed) {
    return () => {
        seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function countingTracker(options = {}) {
    const t = tracker({ maxCacheEntries: 10000, ...options });
    return { t, counter: { get calls() { return t.stats().comparisons; } } };
}

test('a large cluster of near-identical images costs about one comparison per image', () => {
    const { t, counter } = countingTracker();
    const srcs = Array.from({ length: 300 }, (_, i) => `n${i}`);
    show(t, ...srcs);
    // Each differs from A in one bit of its own: every pair is 2 bits apart.
    srcs.forEach((src, i) => {
        t.recordHash(src, { hash: hashWithBits(i * 3), solid: false });
        if (i % 20 === 0) t.groups(); // renders while hashes arrive
    });
    assert.equal(t.groups().groups.length, 1);
    assert.equal(t.groups().sizeBySrc.get('n0'), 300);
    assert.ok(counter.calls < 2 * srcs.length, `${counter.calls} comparisons`);
});

test('unrelated images are not compared at all', () => {
    const { t, counter } = countingTracker();
    const random = seededRandom(1);
    const srcs = Array.from({ length: 2000 }, (_, i) => `u${i}`);
    show(t, ...srcs);
    for (const src of srcs) {
        const hash = Array.from({ length: HASH_LENGTH }, () => Math.floor(random() * 16).toString(16)).join('');
        t.recordHash(src, { hash, solid: false });
    }
    assert.equal(t.groups().groups.length, 0);
    assert.ok(counter.calls < 50, `${counter.calls} comparisons`);
});

test('bands catch a match whose differing bits fall in five different bands', () => {
    for (const bits of [[0, 1, 2, 3, 4], [0, 170, 340, 511, 683], [987, 988, 989, 990, 991]]) {
        const t = tracker();
        show(t, 'x', 'y');
        t.recordHash('x', { hash: A, solid: false });
        t.recordHash('y', { hash: hashWithBits(...bits), solid: false });
        assert.deepEqual(groupsOf(t), [['x', 'y']], `bits ${bits}`);
    }
});

test('matches exactly when at most 5 bits differ, wherever they are', () => {
    const random = seededRandom(3);
    const randomHash = () => Array.from({ length: HASH_LENGTH }, () => Math.floor(random() * 16).toString(16)).join('');
    for (let trial = 0; trial < 300; trial++) {
        const base = randomHash();
        const flips = trial % 11; // 0..10 differing bits
        const positions = new Set();
        while (positions.size < flips) positions.add(Math.floor(random() * HASH_LENGTH * 4));
        const nibbles = [...base].map((c) => parseInt(c, 16));
        for (const p of positions) nibbles[p >> 2] ^= 8 >> (p & 3);
        const other = nibbles.map((n) => n.toString(16)).join('');
        assert.equal(hammingDistance(base, other), flips);

        const t = tracker();
        show(t, 'x', 'y');
        t.recordHash('x', { hash: base, solid: false });
        t.recordHash('y', { hash: other, solid: false });
        assert.equal(groupsOf(t).length, flips <= 5 ? 1 : 0, `${flips} bits at ${[...positions]}`);
    }
});

test('images that share a flat background are not compared with each other', () => {
    const { t, counter } = countingTracker();
    const random = seededRandom(5);
    const srcs = Array.from({ length: 2000 }, (_, i) => `p${i}`);
    show(t, ...srcs);
    for (const src of srcs) {
        // top third of the hash identical (flat rows), the rest unrelated
        const hash = '0'.repeat(80) + Array.from({ length: HASH_LENGTH - 80 }, () => Math.floor(random() * 16).toString(16)).join('');
        t.recordHash(src, { hash, solid: false });
    }
    assert.equal(t.groups().groups.length, 0);
    assert.ok(counter.calls < 50, `${counter.calls} comparisons`);
});

// A hash whose every bit p with p % 6 === 0 is clear (band 0 identical for all), random elsewhere.
function sharedBandHash(random) {
    const nibbles = Array.from({ length: HASH_LENGTH }, () => Math.floor(random() * 16));
    for (let p = 0; p < HASH_LENGTH * 4; p += 6) nibbles[p >> 2] &= ~(8 >> (p & 3));
    return nibbles.map((n) => n.toString(16)).join('');
}

test('images sharing a band cost one comparison each per arrival, and nothing when one leaves', () => {
    const { t, counter } = countingTracker();
    const random = seededRandom(11);
    const srcs = Array.from({ length: 500 }, (_, i) => `s${i}`);
    show(t, ...srcs);
    srcs.forEach((src, i) => {
        const before = counter.calls;
        t.recordHash(src, { hash: sharedBandHash(random), solid: false });
        t.groups();
        assert.ok(counter.calls - before <= i, `arrival ${i}: ${counter.calls - before} comparisons`);
    });
    assert.equal(t.groups().groups.length, 0);

    const before = counter.calls;
    show(t, ...srcs.slice(1)); // one leaves
    assert.equal(t.groups().groups.length, 0);
    assert.equal(counter.calls - before, 0);
});

test('when an image leaves, only its own group is re-checked', () => {
    const { t, counter } = countingTracker();
    const cluster = Array.from({ length: 300 }, (_, i) => `n${i}`);
    show(t, ...cluster, 'p1', 'p2');
    cluster.forEach((src, i) => t.recordHash(src, { hash: hashWithBits(i * 3), solid: false }));
    t.recordHash('p1', { hash: FAR, solid: false });
    t.recordHash('p2', { hash: FAR, solid: false });
    assert.equal(t.groups().groups.length, 2);

    let before = counter.calls;
    show(t, ...cluster, 'p1'); // the pair splits; the cluster is untouched
    assert.deepEqual(groupsOf(t).map((g) => g.length), [300]);
    assert.equal(counter.calls - before, 0);

    before = counter.calls;
    show(t, ...cluster.slice(1), 'p1'); // the cluster loses one and is re-checked
    assert.equal(t.groups().sizeBySrc.get('n1'), 299);
    assert.ok(counter.calls - before < 2 * 300, `${counter.calls - before} comparisons`);
});

test('a candidate sharing several bands is compared once per arrival', () => {
    const { t, counter } = countingTracker();
    show(t, 'x', 'y');
    t.recordHash('x', { hash: A, solid: false });
    // 6 bits apart, all in band 0 (bit p is in band p mod 6): shares the other five bands
    t.recordHash('y', { hash: hashWithBits(0, 6, 12, 18, 24, 30), solid: false });
    assert.deepEqual(groupsOf(t), []);
    assert.equal(counter.calls, 1);
});
