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
        distance: hammingDistance,
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
    assert.deepEqual({ ...t.stats() }, { cached: 1, hashes: 1, links: 0, pending: 0, failed: 0 });
    // The evicted node must no longer link anything: a later B matches nothing on the page.
    show(t, 'b', 'y');
    t.recordHash('b', { hash: B, solid: false });
    assert.deepEqual(groupsOf(t), []);
});

test('evicting a hash unlinks it from its look-alikes', () => {
    const t = tracker({ maxCacheEntries: 2 });
    show(t, 'a', 'b');
    t.recordHash('old', { hash: C, solid: false });
    t.recordHash('a', { hash: A, solid: false });
    assert.equal(t.stats().links, 0);
    t.recordHash('b', { hash: B, solid: false }); // links to A and C
    assert.equal(t.stats().links, 2);
    show(t, 'a', 'b'); // C is evicted
    assert.deepEqual({ ...t.stats() }, { cached: 2, hashes: 2, links: 1, pending: 0, failed: 0 });
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
