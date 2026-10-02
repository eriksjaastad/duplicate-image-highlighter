// Run with: node --test tests/*.test.js
// content.js against a minimal fake DOM: enough to drive scanning, grouping
// and outlines without a browser. Hashing is stubbed with fixed hashes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const EXTENSION = path.join(__dirname, '..', 'extension');
const read = (file) => fs.readFileSync(path.join(EXTENSION, file), 'utf8');

const HASH_LENGTH = 248;
const HASH_LOW = '0'.repeat(HASH_LENGTH);
const HASH_HIGH = 'f'.repeat(HASH_LENGTH);
const HASH_MID = '5'.repeat(HASH_LENGTH);

class FakeStyle {
    constructor() { this.props = new Map(); }
    setProperty(prop, value, priority = '') { this.props.set(prop, { value, priority }); }
    getPropertyValue(prop) { return this.props.get(prop)?.value ?? ''; }
    getPropertyPriority(prop) { return this.props.get(prop)?.priority ?? ''; }
    removeProperty(prop) { this.props.delete(prop); }
}

class FakeImg {
    constructor(src, { width = 400, height = 300 } = {}) {
        this.src = src;
        this.currentSrc = src;
        this.complete = true;
        this.naturalWidth = width;
        this.naturalHeight = height;
        this.style = new FakeStyle();
        this.tagName = 'IMG';
    }
    setSrc(src) { this.src = src; this.currentSrc = src; }
    addEventListener() {}
}

// Loads groups.js and content.js into one fake page, with hashing stubbed.
function loadPage(images, hashes) {
    const page = { images: [...images], timers: new Map(), nextTimer: 1, messages: [], observed: new Set(), observeCalls: 0, hashed: [], held: new Map() };

    const window = {
        addEventListener: () => {}
    };
    const document = {
        addEventListener: (type, fn, capture) => { if (type === 'load' && capture) page.onLoadCapture = fn; },
        createElement: () => ({ getContext: () => ({}) }),
        documentElement: {},
        querySelectorAll: (selector) => (selector === 'img' ? [...page.images] : [])
    };
    const context = {
        window,
        document,
        console: { log() {}, warn() {}, table() {} },
        chrome: {
            runtime: {
                sendMessage: (msg, cb) => { page.messages.push(msg); if (cb) cb(); },
                lastError: undefined
            }
        },
        setTimeout: (fn) => { const id = page.nextTimer++; page.timers.set(id, fn); return id; },
        clearTimeout: (id) => { page.timers.delete(id); },
        IntersectionObserver: class {
            constructor(callback) { page.intersect = callback; this.callback = callback; }
            observe(el) { page.observeCalls++; page.observed.add(el); }
            unobserve(el) { page.observed.delete(el); }
        },
        MutationObserver: class {
            constructor(callback) { page.mutate = callback; }
            observe() {}
        }
    };
    vm.createContext(context);
    // Stands in for hash.js: fixed hashes per URL instead of fetching and decoding.
    window.DuplicateImageHash = {
        pendingCount: () => 0,
        queueHash: (src) => {
            page.hashed.push(src);
            const result = () => (src in hashes ? { hash: hashes[src], solid: false } : null);
            if (!page.held.has(src)) return Promise.resolve(result());
            return new Promise((resolve) => page.held.set(src, () => resolve(result())));
        }
    };
    vm.runInContext(read('groups.js'), context);
    vm.runInContext(read('content.js'), context);

    // Bring every observed image into view, let hashes resolve, run all timers.
    page.settle = async () => {
        for (let round = 0; round < 10; round++) {
            const visible = [...page.observed];
            if (visible.length) page.intersect(visible.map((target) => ({ target, isIntersecting: true })));
            await new Promise((r) => setImmediate(r));
            const due = [...page.timers.entries()];
            page.timers.clear();
            for (const [, fn] of due) fn();
            if (!visible.length && !due.length) return;
        }
        throw new Error('page did not settle');
    };
    // What the page does after a DOM change: the mutation observer fires.
    page.changed = async () => {
        page.mutate();
        await page.settle();
    };
    // A hash for this URL stays in flight until release(src).
    page.hold = (src) => page.held.set(src, null);
    page.release = (src) => { const done = page.held.get(src); page.held.delete(src); done(); };
    // The browser finished loading an image (no DOM mutation involved).
    page.loaded = async (img) => {
        page.onLoadCapture({ target: img });
        await page.settle();
    };
    page.badge = () => page.messages.filter((m) => m.action === 'SCAN_STATUS').at(-1)?.groups;
    page.reinject = () => vm.runInContext(read('content.js'), context);
    return page;
}

const outlined = (img) => img.style.getPropertyValue('outline') !== '';

test('different URLs that look alike are outlined; a unique image is not', async () => {
    const a1 = new FakeImg('https://x.example/a1.png');
    const a2 = new FakeImg('https://x.example/a2.png');
    const u = new FakeImg('https://x.example/u.png');
    const page = loadPage([a1, a2, u], { [a1.src]: HASH_LOW, [a2.src]: HASH_LOW, [u.src]: HASH_HIGH });
    await page.settle();
    assert.equal(outlined(a1), true);
    assert.equal(outlined(a2), true);
    assert.equal(outlined(u), false);
    assert.equal(a1.style.getPropertyPriority('outline'), 'important');
    assert.equal(page.badge(), 1);
});

test('the same URL shown twice is not outlined', async () => {
    const one = new FakeImg('https://x.example/a.png');
    const two = new FakeImg('https://x.example/a.png');
    const page = loadPage([one, two], { [one.src]: HASH_LOW });
    await page.settle();
    assert.equal(outlined(one), false);
    assert.equal(outlined(two), false);
    assert.deepEqual(page.hashed, [one.src], 'hashed once');
    assert.equal(page.badge(), 0);
});

test('changing a src to a unique image clears both outlines and the badge count', async () => {
    const a1 = new FakeImg('https://x.example/a1.png');
    const a2 = new FakeImg('https://x.example/a2.png');
    const page = loadPage([a1, a2], { [a1.src]: HASH_LOW, [a2.src]: HASH_LOW, 'https://x.example/u.png': HASH_HIGH });
    await page.settle();
    assert.equal(page.badge(), 1);

    a2.setSrc('https://x.example/u.png');
    await page.changed();
    assert.equal(outlined(a1), false);
    assert.equal(outlined(a2), false);
    assert.equal(page.badge(), 0);
});

test('removing one of a pair clears the other', async () => {
    const a1 = new FakeImg('https://x.example/a1.png');
    const a2 = new FakeImg('https://x.example/a2.png');
    const page = loadPage([a1, a2], { [a1.src]: HASH_LOW, [a2.src]: HASH_LOW });
    await page.settle();
    page.images = [a1];
    await page.changed();
    assert.equal(outlined(a1), false);
    assert.equal(page.badge(), 0);
});

test('an image added later joins the group and recolors it', async () => {
    const a1 = new FakeImg('https://x.example/a1.png');
    const a2 = new FakeImg('https://x.example/a2.png');
    const a3 = new FakeImg('https://x.example/a3.png');
    const page = loadPage([a1, a2], { [a1.src]: HASH_LOW, [a2.src]: HASH_LOW, [a3.src]: HASH_LOW });
    await page.settle();
    const pairColor = a1.style.getPropertyValue('outline');
    page.images.push(a3);
    await page.changed();
    assert.equal(outlined(a3), true);
    assert.notEqual(a1.style.getPropertyValue('outline'), pairColor);
    assert.equal(a1.style.getPropertyValue('outline'), a3.style.getPropertyValue('outline'));
});

test('clearing restores each outline property the page still owns, independently', async () => {
    const a1 = new FakeImg('https://x.example/a1.png');
    const a2 = new FakeImg('https://x.example/a2.png');
    a1.style.setProperty('outline', '1px dotted red');
    a1.style.setProperty('outline-offset', '2px', 'important');
    const page = loadPage([a1, a2], { [a1.src]: HASH_LOW, [a2.src]: HASH_LOW, 'https://x.example/u.png': HASH_MID });
    await page.settle();
    assert.equal(a1.style.getPropertyValue('outline-offset'), '-4px');

    // The page takes over outline-offset only; outline is still ours.
    a1.style.setProperty('outline-offset', '9px');
    a2.setSrc('https://x.example/u.png');
    await page.changed();
    assert.equal(a1.style.getPropertyValue('outline'), '1px dotted red');
    assert.equal(a1.style.getPropertyPriority('outline'), '');
    assert.equal(a1.style.getPropertyValue('outline-offset'), '9px');
});

test('an image without inline outline styles is left without them', async () => {
    const a1 = new FakeImg('https://x.example/a1.png');
    const a2 = new FakeImg('https://x.example/a2.png');
    const page = loadPage([a1, a2], { [a1.src]: HASH_LOW, [a2.src]: HASH_LOW });
    await page.settle();
    page.images = [a2];
    await page.changed();
    assert.equal(a1.style.props.size, 0);
});

test('images 100x50 or smaller are never hashed', async () => {
    const icon = new FakeImg('https://x.example/icon.png', { width: 100, height: 100 });
    const page = loadPage([icon], {});
    await page.settle();
    assert.deepEqual(page.hashed, []);
    const calls = page.observeCalls;
    await page.changed();
    assert.deepEqual(page.hashed, []);
    assert.equal(page.observeCalls, calls, 'a known-small URL is not watched again');
});

test('an outline the page sets while highlighted is what clearing restores', async () => {
    const a1 = new FakeImg('https://x.example/a1.png');
    const a2 = new FakeImg('https://x.example/a2.png');
    const a3 = new FakeImg('https://x.example/a3.png');
    a1.style.setProperty('outline', '1px dotted red');
    const page = loadPage([a1, a2], { [a1.src]: HASH_LOW, [a2.src]: HASH_LOW, [a3.src]: HASH_LOW });
    await page.settle();

    a1.style.setProperty('outline', '3px dashed blue'); // page's own change while highlighted
    page.images.push(a3); // group grows: the highlight is re-applied over it
    await page.changed();
    assert.match(a1.style.getPropertyValue('outline'), /^4px solid/);

    page.images = [a1];
    await page.changed();
    assert.equal(a1.style.getPropertyValue('outline'), '3px dashed blue');
});

test('clicking again retries an image that failed', async () => {
    const a1 = new FakeImg('https://x.example/a1.png');
    const a2 = new FakeImg('https://x.example/a2.png');
    const hashes = { [a1.src]: HASH_LOW };
    const page = loadPage([a1, a2], hashes);
    await page.settle();
    assert.equal(outlined(a1), false);

    hashes[a2.src] = HASH_LOW; // the second fetch works
    await page.changed();
    assert.equal(outlined(a1), false, 'a failed URL is not retried on its own');
    page.reinject();
    await page.settle();
    assert.equal(outlined(a1), true);
    assert.equal(outlined(a2), true);
});

test('an image whose currentSrc changes on load, with no DOM change, is regrouped', async () => {
    const a1 = new FakeImg('https://x.example/a1.png');
    const lazy = new FakeImg('https://x.example/placeholder.png');
    const page = loadPage([a1, lazy], {
        [a1.src]: HASH_LOW,
        'https://x.example/placeholder.png': HASH_HIGH,
        'https://x.example/a2-800w.png': HASH_LOW
    });
    await page.settle();
    assert.equal(outlined(a1), false);

    lazy.currentSrc = 'https://x.example/a2-800w.png'; // srcset candidate picked; src attribute unchanged
    await page.loaded(lazy);
    assert.equal(outlined(a1), true);
    assert.equal(outlined(lazy), true);
    assert.equal(page.badge(), 1);
});

test('a hash that resolves after its image was removed does not outline anything', async () => {
    const a1 = new FakeImg('https://x.example/a1.png');
    const a2 = new FakeImg('https://x.example/a2.png');
    const page = loadPage([a1, a2], { [a1.src]: HASH_LOW, [a2.src]: HASH_LOW });
    page.hold(a2.src);
    await page.settle();
    page.images = [a1];
    await page.changed();
    page.release(a2.src);
    await page.settle();
    assert.equal(outlined(a1), false);
    assert.equal(page.badge(), 0);
});

test('a hash that resolves after its image changed src does not outline the new image', async () => {
    const a1 = new FakeImg('https://x.example/a1.png');
    const a2 = new FakeImg('https://x.example/a2.png');
    const page = loadPage([a1, a2], { [a1.src]: HASH_LOW, [a2.src]: HASH_LOW, 'https://x.example/u.png': HASH_HIGH });
    page.hold(a2.src);
    await page.settle();
    a2.setSrc('https://x.example/u.png');
    await page.changed();
    page.release('https://x.example/a2.png');
    await page.settle();
    assert.equal(outlined(a1), false);
    assert.equal(outlined(a2), false);
    assert.equal(page.badge(), 0);
});
