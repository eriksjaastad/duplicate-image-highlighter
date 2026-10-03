// Run with: node --test tests/*.test.js
// content.js against a minimal fake DOM: enough to drive observing, matching,
// the stripe and pill, and the shortcuts without a browser. Hashing is stubbed
// with fixed hashes per URL; hammingDistance is the real one from hash.js.
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

// A hash of 'a' digits with `flips` digits turned to 'b' (one bit each), starting at `from`.
function hashWithFlips(from, flips) {
    const digits = 'a'.repeat(HASH_LENGTH).split('');
    for (let i = from; i < from + flips; i++) digits[i] = 'b';
    return digits.join('');
}
const BASE = hashWithFlips(0, 0);

function realHammingDistance() {
    const window = {};
    vm.runInNewContext(read('hash.js'), {
        window,
        document: { createElement: () => ({ getContext: () => ({}) }) },
        chrome: {}
    });
    return window.DuplicateImageHash.hammingDistance;
}
const hammingDistance = realHammingDistance();

class FakeElement {
    constructor(tagName, page) {
        this.tagName = tagName.toUpperCase();
        this.page = page;
        this.children = [];
        this.parentElement = null;
        this.style = {};
        this.className = '';
        this.attributes = {};
        this.textContent = '';
        this.computedPosition = 'static'; // what the page's stylesheets say
    }
    appendChild(child) {
        if (child.parentElement) child.remove();
        child.parentElement = this;
        this.children.push(child);
        return child;
    }
    remove() {
        if (!this.parentElement) return;
        const siblings = this.parentElement.children;
        siblings.splice(siblings.indexOf(this), 1);
        this.parentElement = null;
    }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    *descendants() {
        for (const child of this.children) {
            yield child;
            yield* child.descendants();
        }
    }
    querySelector(selector) {
        const cls = selector.slice(1); // only '.class' is used
        for (const el of this.descendants()) if (el.className.split(' ').includes(cls)) return el;
        return null;
    }
    byClass(cls) { return this.children.filter((el) => el.className === cls); }
}

class FakeImg extends FakeElement {
    constructor(page, src, { width = 400, height = 300, currentSrc = src } = {}) {
        super('img', page);
        this.src = src;
        this.currentSrc = currentSrc;
        this.naturalWidth = width;
        this.naturalHeight = height;
    }
}

// Loads content.js into a fake page. `hashes` maps URL -> hash (missing = failed).
function loadPage(hashes = {}) {
    const page = {
        timers: new Map(), nextTimer: 1, observed: new Set(), observeCalls: [], hashed: [],
        keyListeners: [], logs: [], tables: [], reloads: 0, constructed: { intersection: 0, mutation: 0 }
    };
    const body = new FakeElement('body', page);
    page.body = body;

    // An image in its own wrapper div under body.
    page.addImage = (src, opts) => {
        const wrapper = body.appendChild(new FakeElement('div', page));
        const img = wrapper.appendChild(new FakeImg(page, src, opts));
        return img;
    };

    const window = {
        addEventListener: (type, fn) => { if (type === 'keydown') page.keyListeners.push(fn); },
        getComputedStyle: (el) => ({ position: el.style.position || el.computedPosition })
    };
    const context = {
        window,
        document: {
            body,
            createElement: (tag) => new FakeElement(tag, page),
            querySelectorAll: (selector) => (selector === 'img' ? [...body.descendants()].filter((el) => el.tagName === 'IMG') : [])
        },
        location: { reload: () => { page.reloads++; } },
        console: {
            log: (...args) => page.logs.push(args.map(String).join(' ')),
            warn() {},
            table: (rows) => page.tables.push(Array.from(rows, (r) => ({ ...r, urls: Array.from(r.urls) })))
        },
        setTimeout: (fn, ms) => { const id = page.nextTimer++; page.timers.set(id, { fn, ms }); return id; },
        clearTimeout: (id) => { page.timers.delete(id); },
        IntersectionObserver: class {
            constructor(callback, options) {
                page.constructed.intersection++;
                page.intersect = callback;
                page.intersectionOptions = options;
            }
            observe(el) { page.observeCalls.push(el); page.observed.add(el); }
            unobserve(el) { page.observed.delete(el); }
        },
        MutationObserver: class {
            constructor(callback) { page.constructed.mutation++; page.mutate = callback; }
            observe(target, options) { page.mutationTarget = target; page.mutationOptions = options; }
        }
    };
    vm.createContext(context);
    // Stands in for hash.js: fixed hashes per URL instead of fetching and decoding.
    window.DuplicateImageHash = {
        hammingDistance,
        queueHash: (src) => {
            page.hashed.push(src);
            return Promise.resolve(src in hashes ? hashes[src] : null);
        }
    };
    page.inject = () => vm.runInContext(read('content.js'), context);
    page.inject();
    page.window = window;

    page.runTimers = () => {
        const due = [...page.timers.values()];
        page.timers.clear();
        for (const { fn } of due) fn();
    };
    // Bring the given (default: all observed) images into view and let hashes resolve.
    page.scroll = async (imgs = [...page.observed]) => {
        page.intersect(imgs.map((target) => ({ target, isIntersecting: true })));
        await new Promise((r) => setImmediate(r));
    };
    // Initial pass after 500ms, then everything scrolls into view.
    page.settle = async () => {
        page.runTimers();
        await page.scroll();
    };
    page.press = (code, { altKey = true, shiftKey = true } = {}) => {
        for (const fn of page.keyListeners) fn({ code, altKey, shiftKey });
    };
    return page;
}

const stripeOf = (img) => img.parentElement.byClass('dih-stripe');
const pillOf = (img) => img.parentElement.byClass('dih-count');
const isMarked = (img) => stripeOf(img).length === 1 && pillOf(img).length === 1;

function expectedStyles(count) {
    const t = (Math.min(count, 10) - 1) / 9;
    const hue = 200 - 200 * t;
    const a = `hsla(${hue}, 100%, 50%, 0.3)`;
    const b = `hsla(${hue}, 100%, 50%, 0.05)`;
    return {
        hue,
        background: `repeating-linear-gradient(45deg, ${a}, ${a} 2px, ${b} 2px, ${b} ${20 - 15 * t}px)`
    };
}

function assertMarked(img, count, literal) {
    const { hue, background } = expectedStyles(count);
    if (literal) {
        assert.equal(hue, literal.hue);
        assert.equal(background, literal.background);
    }
    assert.equal(img.style.outline, `3px solid hsl(${hue}, 100%, 50%)`);
    assert.equal(img.style.outlineOffset, '-4px');

    const [stripe] = stripeOf(img);
    assert.ok(stripe, 'stripe overlay');
    assert.deepEqual({ ...stripe.style }, {
        position: 'absolute',
        top: '0',
        left: '0',
        width: '100%',
        height: '100%',
        backgroundImage: background,
        pointerEvents: 'none',
        zIndex: String(1000 + count - 1),
        borderRadius: 'inherit'
    });

    const [pill] = pillOf(img);
    assert.ok(pill, 'count pill');
    assert.equal(pill.textContent, String(count));
    assert.equal(pill.getAttribute('title'), `Duplicate: ${count} copies on this page`);
    assert.deepEqual({ ...pill.style }, {
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
    });
}

test('observers: 500px root margin, threshold 0, childList+subtree on body, first pass after 500ms', async () => {
    const page = loadPage({ 'https://x.example/a.jpg': BASE });
    const img = page.addImage('https://x.example/a.jpg');
    assert.deepEqual({ ...page.intersectionOptions }, { rootMargin: '500px', threshold: 0 });
    assert.equal(page.mutationTarget, page.body);
    assert.deepEqual({ ...page.mutationOptions }, { childList: true, subtree: true });

    assert.deepEqual([...page.timers.values()].map((t) => t.ms), [500]);
    assert.equal(page.observed.size, 0, 'nothing observed before the first pass');
    page.runTimers();
    assert.deepEqual([...page.observed], [img]);

    await page.scroll();
    assert.equal(page.observed.size, 0, 'unobserved once it intersected');
    assert.deepEqual(page.hashed, ['https://x.example/a.jpg']);
});

test('DOM changes are debounced to one observe pass 500ms after the last one', async () => {
    const page = loadPage();
    page.runTimers();
    page.addImage('https://x.example/a.jpg');
    page.mutate();
    page.mutate();
    page.mutate();
    assert.deepEqual([...page.timers.values()].map((t) => t.ms), [500]);
    page.runTimers();
    assert.equal(page.observeCalls.length, 1);
});

test('two different URLs that look the same get the stripe and pill for count 2', async () => {
    const page = loadPage({ 'https://x.example/a.jpg': BASE, 'https://x.example/b.jpg': BASE });
    const a = page.addImage('https://x.example/a.jpg');
    const b = page.addImage('https://x.example/b.jpg');
    await page.settle();
    const literal = {
        hue: 177.77777777777777,
        background: 'repeating-linear-gradient(45deg, hsla(177.77777777777777, 100%, 50%, 0.3), ' +
            'hsla(177.77777777777777, 100%, 50%, 0.3) 2px, hsla(177.77777777777777, 100%, 50%, 0.05) 2px, ' +
            'hsla(177.77777777777777, 100%, 50%, 0.05) 18.333333333333332px)'
    };
    assertMarked(a, 2, literal);
    assertMarked(b, 2, literal);
    assert.equal(a.parentElement.style.position, 'relative', 'static parent made relative');
});

test('ten look-alike URLs get the red stripe and pill for count 10', async () => {
    const hashes = {};
    for (let i = 0; i < 10; i++) hashes[`https://x.example/${i}.jpg`] = hashWithFlips(0, i % 3); // within 2 bits
    const page = loadPage(hashes);
    const imgs = Object.keys(hashes).map((src) => page.addImage(src));
    await page.settle();
    for (const img of imgs) {
        assertMarked(img, 10, {
            hue: 0,
            background: 'repeating-linear-gradient(45deg, hsla(0, 100%, 50%, 0.3), hsla(0, 100%, 50%, 0.3) 2px, ' +
                'hsla(0, 100%, 50%, 0.05) 2px, hsla(0, 100%, 50%, 0.05) 5px)'
        });
    }
});

test('the hue stops at red above 10, but the count and z-index keep going', () => {
    const page = loadPage();
    const img = page.addImage('https://x.example/a.jpg');
    page.window.__duplicateImageHighlighter.markDuplicate(img, 12);
    assert.equal(img.style.outline, '3px solid hsl(0, 100%, 50%)');
    assert.equal(pillOf(img)[0].textContent, '12');
    assert.equal(pillOf(img)[0].style.zIndex, '1012');
    assert.equal(stripeOf(img)[0].style.zIndex, '1011');
});

test('re-marking replaces the stripe and pill; a count of 1 clears them and the outline', () => {
    const page = loadPage();
    const img = page.addImage('https://x.example/a.jpg');
    const { markDuplicate } = page.window.__duplicateImageHighlighter;
    markDuplicate(img, 2);
    markDuplicate(img, 3);
    assert.equal(stripeOf(img).length, 1);
    assert.equal(pillOf(img).length, 1);
    assertMarked(img, 3);

    markDuplicate(img, 1);
    assert.equal(stripeOf(img).length, 0);
    assert.equal(pillOf(img).length, 0);
    assert.equal(img.style.outline, '');
    assert.deepEqual(img.parentElement.children, [img]);
});

test('a positioned parent keeps its position', () => {
    const page = loadPage();
    const img = page.addImage('https://x.example/a.jpg');
    img.parentElement.computedPosition = 'absolute';
    page.window.__duplicateImageHighlighter.markDuplicate(img, 2);
    assert.equal(img.parentElement.style.position, undefined);
});

test('the same URL twice is not a duplicate', async () => {
    const page = loadPage({ 'https://x.example/a.jpg': BASE });
    const a = page.addImage('https://x.example/a.jpg');
    const b = page.addImage('https://x.example/a.jpg');
    await page.settle();
    assert.equal(isMarked(a), false);
    assert.equal(isMarked(b), false);
    assert.equal(a.style.outline, undefined);
});

test('a new hash joins the first stored hash within 5 bits: no chaining, order matters', async () => {
    // A~B (4 bits), B~C (4 bits), A and C 8 bits apart.
    const A = BASE;
    const B = hashWithFlips(0, 4);
    const C = hashWithFlips(0, 8);
    assert.deepEqual([hammingDistance(A, B), hammingDistance(B, C), hammingDistance(A, C)], [4, 4, 8]);
    const urls = { a: 'https://x.example/a.jpg', b: 'https://x.example/b.jpg', c: 'https://x.example/c.jpg' };
    const hashes = { [urls.a]: A, [urls.b]: B, [urls.c]: C };

    // Order A, B, C: B joins A; C is 8 bits from A, so it starts its own key.
    let page = loadPage(hashes);
    let imgs = ['a', 'b', 'c'].map((k) => page.addImage(urls[k]));
    await page.settle();
    assert.deepEqual(imgs.map(isMarked), [true, true, false]);
    assert.equal(pillOf(imgs[0])[0].textContent, '2');

    // Order B, A, C: both A and C are within 5 bits of B, so all three share B's key.
    page = loadPage(hashes);
    imgs = ['b', 'a', 'c'].map((k) => page.addImage(urls[k]));
    await page.settle();
    assert.deepEqual(imgs.map(isMarked), [true, true, true]);
    assert.equal(pillOf(imgs[0])[0].textContent, '3');
});

test('images with no src, data: URLs and images not bigger than 100x50 are never hashed', async () => {
    const page = loadPage();
    page.addImage('');
    page.addImage('data:image/png;base64,AAAA');
    page.addImage('https://x.example/narrow.jpg', { width: 100, height: 300 });
    page.addImage('https://x.example/short.jpg', { width: 400, height: 50 });
    page.addImage('https://x.example/ok.jpg', { width: 101, height: 51 });
    await page.settle();
    assert.deepEqual(page.hashed, ['https://x.example/ok.jpg']);
});

test('hashes that are all 0 or all f are skipped, so flat placeholders never match', async () => {
    const page = loadPage({
        'https://x.example/0a.jpg': HASH_LOW,
        'https://x.example/0b.jpg': HASH_LOW,
        'https://x.example/fa.jpg': HASH_HIGH,
        'https://x.example/fb.jpg': HASH_HIGH
    });
    const imgs = ['0a', '0b', 'fa', 'fb'].map((n) => page.addImage(`https://x.example/${n}.jpg`));
    await page.settle();
    assert.equal(page.hashed.length, 4);
    assert.deepEqual(imgs.map(isMarked), [false, false, false, false]);
    page.press('KeyD');
    assert.ok(page.logs.includes('Processed URLs: 0'));
    assert.ok(page.logs.includes('Unique hashes: 0'));
});

test('every image showing a URL in the group is marked, by currentSrc or src', async () => {
    const page = loadPage({ 'https://x.example/a.jpg': BASE, 'https://x.example/b.jpg': BASE });
    page.addImage('https://x.example/a.jpg');
    page.addImage('https://x.example/b.jpg');
    // Not observed yet when the group forms: matched by src (currentSrc empty)
    const late = page.addImage('https://x.example/a.jpg', { currentSrc: '' });
    page.runTimers();
    page.observed.delete(late);
    await page.scroll();
    assertMarked(late, 2);
});

test('an image added later with a known URL is marked by the observe pass, not hashed again', async () => {
    const page = loadPage({ 'https://x.example/a.jpg': BASE, 'https://x.example/b.jpg': BASE });
    page.addImage('https://x.example/a.jpg');
    page.addImage('https://x.example/b.jpg');
    await page.settle();
    const added = page.addImage('https://x.example/b.jpg');
    page.mutate();
    page.runTimers();
    assert.equal(page.observed.has(added), false);
    assertMarked(added, 2);
    assert.equal(page.hashed.length, 2);
});

test('a failed URL is not retried until Alt+Shift+R reloads the page', async () => {
    const page = loadPage({}); // every hash fails
    page.addImage('https://x.example/broken.jpg');
    await page.settle();
    assert.deepEqual(page.hashed, ['https://x.example/broken.jpg']);

    const again = page.addImage('https://x.example/broken.jpg');
    page.press('KeyS');
    assert.equal(page.observed.has(again), false, 'failed URL not observed again');

    page.press('KeyD');
    assert.ok(page.logs.includes('Failed URLs: 1'));
    page.press('KeyR');
    assert.equal(page.reloads, 1);
    page.logs.length = 0;
    page.press('KeyD');
    assert.deepEqual(page.logs.slice(1), ['Processed URLs: 0', 'Unique hashes: 0', 'Failed URLs: 0']);
});

test('Alt+Shift+D logs counts and a table of only the groups with more than one URL', async () => {
    const page = loadPage({
        'https://x.example/a.jpg': BASE,
        'https://x.example/b.jpg': BASE,
        'https://x.example/lonely.jpg': hashWithFlips(100, 40)
    });
    page.addImage('https://x.example/a.jpg');
    page.addImage('https://x.example/b.jpg');
    page.addImage('https://x.example/lonely.jpg');
    await page.settle();
    page.logs.length = 0;
    page.press('KeyD');
    assert.deepEqual(page.logs.slice(1), ['Processed URLs: 3', 'Unique hashes: 2', 'Failed URLs: 0']);
    assert.deepEqual(page.tables, [[{
        hash: BASE.slice(0, 16) + '...',
        count: 2,
        urls: ['https://x.example/a.jpg...', 'https://x.example/b.jpg...']
    }]]);
});

test('Alt+Shift+S runs the observe pass again', () => {
    const page = loadPage();
    page.runTimers();
    const img = page.addImage('https://x.example/a.jpg');
    page.press('KeyS');
    assert.deepEqual([...page.observed], [img]);
});

test('only the three Alt+Shift shortcuts do anything', () => {
    const page = loadPage();
    page.runTimers();
    page.addImage('https://x.example/a.jpg');
    page.press('KeyS', { altKey: false });
    page.press('KeyR', { shiftKey: false });
    page.press('KeyD', { altKey: false });
    for (const code of ['KeyA', 'KeyC', 'KeyH', 'KeyX']) page.press(code);
    assert.equal(page.observed.size, 0);
    assert.equal(page.reloads, 0);
    assert.equal(page.tables.length, 0);
    assert.equal(page.keyListeners.length, 1);
});

test('a second injection rescans once and adds no observer or shortcut listener', async () => {
    const page = loadPage({ 'https://x.example/a.jpg': BASE });
    page.runTimers();
    const img = page.addImage('https://x.example/a.jpg');

    page.inject();
    assert.deepEqual(page.observeCalls, [img], 'observe pass ran once');
    assert.deepEqual(page.constructed, { intersection: 1, mutation: 1 });
    assert.equal(page.keyListeners.length, 1);
    assert.equal(page.timers.size, 0, 'no second delayed first pass');

    page.inject();
    assert.deepEqual(page.observeCalls, [img], 'an image already observed is not observed twice');
});
