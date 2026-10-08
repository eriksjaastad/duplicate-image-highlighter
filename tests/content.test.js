// Run with: node --test tests/*.test.js
// content.js against a minimal fake DOM: enough to drive observing, matching,
// the stripe and pill, and the shortcuts without a browser. Hashing is stubbed
// with fixed hashes per URL; hammingDistance is the real one from hash.js.
// Options: `serialize` rewrites every inline style value on write, the way a
// browser re-serializes colors; `deferred` holds each hash until
// page.resolveHash(src); `liveMutations` fires the MutationObserver callback on
// every child added to or removed from the page, with a record naming that child.
// page.mutate() with no records stands for an unrelated page change.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadHash } = require('./helpers');

const CONTENT_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'extension', 'content.js'), 'utf8');

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

const { hammingDistance } = loadHash();

class FakeElement {
    constructor(tagName, page) {
        this.tagName = tagName.toUpperCase();
        this.page = page;
        this.children = [];
        this.parentElement = null;
        this.style = page.serialize
            ? new Proxy({}, { set: (target, name, value) => { target[name] = page.serialize(value); return true; } })
            : {};
        this.className = '';
        this.attributes = {};
        this.textContent = '';
        this.computedPosition = 'static'; // what the page's stylesheets say
    }
    get classList() {
        return { contains: (cls) => this.className.split(' ').includes(cls) };
    }
    get isConnected() {
        let el = this;
        while (el.parentElement) el = el.parentElement;
        return el === this.page.body;
    }
    appendChild(child) {
        if (child.parentElement) child.remove();
        child.parentElement = this;
        this.children.push(child);
        if (this.isConnected) this.page.childListChanged({ addedNodes: [child], removedNodes: [] });
        return child;
    }
    remove() {
        if (!this.parentElement) return;
        const connected = this.parentElement.isConnected;
        const record = { addedNodes: [], removedNodes: [this] };
        const siblings = this.parentElement.children;
        siblings.splice(siblings.indexOf(this), 1);
        this.parentElement = null;
        if (connected) this.page.childListChanged(record);
    }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    *descendants() {
        for (const child of this.children) {
            yield child;
            yield* child.descendants();
        }
    }
    // Only the ':scope > .class' form content.js uses: a direct child.
    querySelector(selector) {
        const cls = selector.match(/^:scope > \.([\w-]+)$/)[1];
        return this.children.find((el) => el.classList.contains(cls)) ?? null;
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
function loadPage(hashes = {}, { serialize = null, deferred = false, liveMutations = false } = {}) {
    const page = {
        timers: new Map(), nextTimer: 1, observed: new Set(), observeCalls: [], hashed: [],
        keyListeners: [], logs: [], tables: [], reloads: 0, constructed: { intersection: 0, mutation: 0 },
        serialize, childListChanges: 0, waiting: new Map()
    };
    page.childListChanged = (record) => {
        page.childListChanges++;
        if (liveMutations && page.mutate) page.mutate([record]);
    };
    // Release a deferred hash and let its result settle.
    page.resolveHash = async (src) => {
        const resolvers = page.waiting.get(src);
        page.waiting.delete(src);
        for (const resolve of resolvers) resolve(src in hashes ? hashes[src] : null);
        await new Promise((r) => setImmediate(r));
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
            constructor(callback) {
                page.constructed.mutation++;
                page.mutate = (records = [{ addedNodes: [new FakeElement('div', page)], removedNodes: [] }]) =>
                    callback(records, this);
            }
            observe(target, options) { page.mutationTarget = target; page.mutationOptions = options; }
        }
    };
    vm.createContext(context);
    // Stands in for hash.js: fixed hashes per URL instead of fetching and decoding.
    window.DuplicateImageHash = {
        hammingDistance,
        queueHash: (src) => {
            page.hashed.push(src);
            if (!deferred) return Promise.resolve(src in hashes ? hashes[src] : null);
            return new Promise((resolve) => {
                if (!page.waiting.has(src)) page.waiting.set(src, []);
                page.waiting.get(src).push(resolve);
            });
        }
    };
    page.inject = () => vm.runInContext(CONTENT_SOURCE, context);
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

test('colors run from blue at 2 to red at 10; above 10 the hue stays red but the count and z-index keep going', async () => {
    const hashes = { 'https://x.example/a.jpg': BASE, 'https://x.example/b.jpg': BASE };
    // Ten more URLs within 2 bits of each other and at least 40 bits from BASE.
    for (let i = 0; i < 10; i++) hashes[`https://x.example/${i}.jpg`] = hashWithFlips(100, 40 + (i % 3));
    const page = loadPage(hashes);
    const [a, b, ...ten] = Object.keys(hashes).map((src) => page.addImage(src));
    await page.settle();

    const two = {
        hue: 177.77777777777777,
        background: 'repeating-linear-gradient(45deg, hsla(177.77777777777777, 100%, 50%, 0.3), ' +
            'hsla(177.77777777777777, 100%, 50%, 0.3) 2px, hsla(177.77777777777777, 100%, 50%, 0.05) 2px, ' +
            'hsla(177.77777777777777, 100%, 50%, 0.05) 18.333333333333332px)'
    };
    assertMarked(a, 2, two);
    assertMarked(b, 2, two);
    assert.equal(a.parentElement.style.position, 'relative', 'static parent made relative');
    for (const img of ten) {
        assertMarked(img, 10, {
            hue: 0,
            background: 'repeating-linear-gradient(45deg, hsla(0, 100%, 50%, 0.3), hsla(0, 100%, 50%, 0.3) 2px, ' +
                'hsla(0, 100%, 50%, 0.05) 2px, hsla(0, 100%, 50%, 0.05) 5px)'
        });
    }

    page.window.__duplicateImageHighlighter.markDuplicate(a, 12);
    assert.equal(a.style.outline, '3px solid hsl(0, 100%, 50%)');
    assert.equal(pillOf(a)[0].textContent, '12');
    assert.equal(pillOf(a)[0].style.zIndex, '1012');
    assert.equal(stripeOf(a)[0].style.zIndex, '1011');
});

test('re-marking replaces only what no longer matches: a new count, or a rewritten outline or pill', () => {
    const page = loadPage();
    const img = page.addImage('https://x.example/a.jpg');
    const { markDuplicate } = page.window.__duplicateImageHighlighter;
    markDuplicate(img, 2);
    markDuplicate(img, 3);
    assert.equal(isMarked(img), true, 'one stripe and one pill');
    assertMarked(img, 3);
    const [stripe] = stripeOf(img);
    const [pill] = pillOf(img);

    img.style.outline = 'none';
    const changes = page.childListChanges;
    markDuplicate(img, 3);
    assertMarked(img, 3);
    assert.equal(page.childListChanges, changes, 'only the outline was rewritten');
    assert.equal(stripeOf(img)[0], stripe);
    assert.equal(pillOf(img)[0], pill);

    pill.style.zIndex = '1';
    markDuplicate(img, 3);
    assertMarked(img, 3);
    assert.notEqual(pillOf(img)[0], pill, 'a changed pill is replaced');
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

test('the match threshold is 5 bits: a hash 5 bits from a stored one joins it, one 6 bits away does not', async () => {
    const near = hashWithFlips(0, 5);
    const far = hashWithFlips(100, 6);
    assert.deepEqual([hammingDistance(BASE, near), hammingDistance(BASE, far)], [5, 6]);
    const urls = ['https://x.example/base.jpg', 'https://x.example/near.jpg', 'https://x.example/far.jpg'];
    const page = loadPage({ [urls[0]]: BASE, [urls[1]]: near, [urls[2]]: far });
    const imgs = urls.map((src) => page.addImage(src));
    await page.settle();
    assert.deepEqual(imgs.map(isMarked), [true, true, false]);
    assert.equal(pillOf(imgs[0])[0].textContent, '2');
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

test('only the three Alt+Shift shortcuts do anything; Alt+Shift+S runs the observe pass again', () => {
    const page = loadPage();
    page.runTimers();
    const img = page.addImage('https://x.example/a.jpg');
    page.press('KeyS', { altKey: false });
    page.press('KeyR', { shiftKey: false });
    page.press('KeyX');
    assert.equal(page.observed.size, 0);
    assert.equal(page.reloads, 0);
    assert.equal(page.tables.length, 0);
    assert.equal(page.keyListeners.length, 1);

    page.press('KeyS');
    assert.deepEqual([...page.observed], [img]);
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

test('an image added later with a known URL is marked by the observe pass, not hashed, and the scan settles', async () => {
    // A browser reads inline styles back re-serialized; the fake drops the space after commas.
    const page = loadPage(
        { 'https://x.example/a.jpg': BASE, 'https://x.example/b.jpg': BASE },
        { serialize: (value) => String(value).replace(/, /g, ','), liveMutations: true }
    );
    page.addImage('https://x.example/a.jpg');
    page.addImage('https://x.example/b.jpg');
    await page.settle();

    // Known URL, never observed: every pass remarks it.
    const late = page.addImage('https://x.example/b.jpg');
    page.runTimers();
    assert.equal(page.observed.has(late), false);
    assert.equal(page.hashed.length, 2);
    assert.equal(isMarked(late), true);
    assert.equal(pillOf(late)[0].textContent, '2');
    assert.equal(late.style.outline, '3px solid hsl(177.77777777777777,100%,50%)');
    const [stripe] = stripeOf(late);
    const [pill] = pillOf(late);

    // Adding our own stripe and pill schedules no pass; a repeat pass changes nothing.
    assert.equal(page.timers.size, 0, 'no pass scheduled by our own decorations');
    const changes = page.childListChanges;
    page.press('KeyS');
    assert.equal(page.childListChanges, changes, 'no stripe or pill removed or added');
    assert.equal(page.timers.size, 0);
    assert.equal(stripeOf(late)[0], stripe);
    assert.equal(pillOf(late)[0], pill);
});

test('two images sharing a parent with different counts do not keep rescheduling the scan', async () => {
    const urls = {
        a: 'https://x.example/a.jpg', a2: 'https://x.example/a2.jpg',
        b: 'https://x.example/b.jpg', b2: 'https://x.example/b2.jpg', b3: 'https://x.example/b3.jpg'
    };
    const B = hashWithFlips(100, 40);
    const page = loadPage(
        { [urls.a]: BASE, [urls.a2]: BASE, [urls.b]: B, [urls.b2]: B, [urls.b3]: B },
        { liveMutations: true }
    );
    for (const src of Object.values(urls)) page.addImage(src);
    await page.settle();
    page.runTimers(); // the pass the decorations above used to schedule, if any

    // Known URLs, never observed: every pass remarks both, and each replaces the other's pill.
    const shared = page.body.appendChild(new FakeElement('div', page));
    const imgA = shared.appendChild(new FakeImg(page, urls.a));
    const imgB = shared.appendChild(new FakeImg(page, urls.b));
    assert.equal(page.timers.size, 1, 'adding the images schedules a pass');
    const changes = page.childListChanges;
    page.runTimers();
    assert.ok(page.childListChanges > changes, 'the pass swapped the shared stripe and pill');
    assert.equal(pillOf(imgB)[0].textContent, '3');
    assert.equal(imgA.style.outline, `3px solid hsl(${expectedStyles(2).hue}, 100%, 50%)`);

    assert.equal(page.timers.size, 0, 'our own stripe and pill swaps schedule no pass');
    const swapped = page.childListChanges;
    page.press('KeyS');
    assert.ok(page.childListChanges > swapped, 'a rescan swaps them again');
    assert.equal(page.timers.size, 0, 'and still schedules no pass');

    // A real page change still schedules one.
    page.body.appendChild(new FakeElement('div', page));
    assert.equal(page.timers.size, 1);
});

test('only the direct-child stripe and pill belong to an image; a nested image keeps its own', () => {
    const page = loadPage();
    const { markDuplicate } = page.window.__duplicateImageHighlighter;
    const outer = page.addImage('https://x.example/outer.jpg');
    const innerWrapper = outer.parentElement.appendChild(new FakeElement('div', page));
    const inner = innerWrapper.appendChild(new FakeImg(page, 'https://x.example/inner.jpg'));

    // The nested decoration showing the same count is not taken as the outer image's.
    markDuplicate(inner, 3);
    markDuplicate(outer, 3);
    assertMarked(inner, 3);
    assertMarked(outer, 3);
    const [innerStripe] = stripeOf(inner);
    const [innerPill] = pillOf(inner);

    markDuplicate(outer, 4);
    assertMarked(outer, 4);
    assert.equal(isMarked(outer), true, 'the outer image\'s old stripe and pill are gone');
    assertMarked(inner, 3);
    assert.equal(stripeOf(inner)[0], innerStripe);
    assert.equal(pillOf(inner)[0], innerPill);
});

test('a URL whose hash is in flight is not queued again; its other images share the result', async () => {
    const urls = { a: 'https://x.example/a.jpg', b: 'https://x.example/b.jpg' };
    const page = loadPage({ [urls.a]: BASE, [urls.b]: BASE }, { deferred: true });
    const a1 = page.addImage(urls.a);
    const a2 = page.addImage(urls.a);
    const b = page.addImage(urls.b);
    page.runTimers();

    await page.scroll([a1]);
    await page.scroll([a2, b]);
    assert.deepEqual(page.hashed, [urls.a, urls.b]);

    await page.resolveHash(urls.b);
    await page.resolveHash(urls.a);
    for (const img of [a1, a2, b]) assertMarked(img, 2);
    assert.deepEqual(page.hashed, [urls.a, urls.b], 'each URL hashed once');
});

test('an image waiting on an in-flight hash is not marked if its src changed meanwhile', async () => {
    const urls = { a: 'https://x.example/a.jpg', b: 'https://x.example/b.jpg', unique: 'https://x.example/unique.jpg' };
    const page = loadPage({ [urls.a]: BASE, [urls.b]: BASE }, { deferred: true });
    const first = page.addImage(urls.a);
    const second = page.addImage(urls.a);
    const b = page.addImage(urls.b);
    page.runTimers();
    await page.scroll([first]);
    await page.scroll([second, b]);
    await page.resolveHash(urls.b);

    second.src = second.currentSrc = urls.unique;
    await page.resolveHash(urls.a);
    assertMarked(first, 2);
    assertMarked(b, 2);
    assert.equal(isMarked(second), false);
    assert.deepEqual(pillOf(second), []);
    assert.equal(second.style.outline, undefined);
    assert.deepEqual(page.hashed, [urls.a, urls.b], 'the new URL is not hashed');
});

test('the in-flight mark clears when the hash finishes', async () => {
    // A flat hash is not stored, so a later image with that URL is hashed again
    // unless a stale in-flight mark holds it back.
    const flat = 'https://x.example/flat.jpg';
    const page = loadPage({ [flat]: HASH_LOW }, { deferred: true });
    const first = page.addImage(flat);
    const second = page.addImage(flat);
    page.runTimers();
    await page.scroll([first, second]);
    assert.deepEqual(page.hashed, [flat]);
    await page.resolveHash(flat);

    const later = page.addImage(flat);
    page.mutate();
    page.runTimers();
    await page.scroll([later]);
    assert.deepEqual(page.hashed, [flat, flat]);
});

test('an image removed before it came into view is no longer watched; one still on the page is', () => {
    const page = loadPage();
    page.runTimers();
    const gone = page.addImage('https://x.example/gone.jpg');
    const kept = page.addImage('https://x.example/kept.jpg');
    page.mutate();
    page.runTimers();
    assert.deepEqual([...page.observed], [gone, kept]);

    const wrapper = gone.parentElement;
    wrapper.remove();
    page.mutate();
    page.runTimers();
    assert.deepEqual([...page.observed], [kept]);

    // Dropped from the observed set, so it is watched again if it comes back.
    page.body.appendChild(wrapper);
    page.mutate();
    page.runTimers();
    assert.deepEqual([...page.observed], [kept, gone]);
    assert.deepEqual(page.observeCalls, [gone, kept, gone], 'kept observed only once');
});

test('limit: an image that came into view before it decoded is not watched again', async () => {
    const page = loadPage({ 'https://x.example/a.jpg': BASE, 'https://x.example/b.jpg': BASE });
    const img = page.addImage('https://x.example/a.jpg', { width: 0, height: 0 });
    page.runTimers();
    await page.scroll();
    assert.deepEqual(page.hashed, []);

    img.naturalWidth = 400;
    img.naturalHeight = 300;
    page.press('KeyS');
    page.mutate();
    page.runTimers();
    page.inject();
    assert.deepEqual(page.observeCalls, [img], 'not observed again');
    assert.equal(page.observed.size, 0);
    assert.deepEqual(page.hashed, []);

    // Nor is an image whose src changed after it was hashed.
    const changed = page.addImage('https://x.example/b.jpg');
    page.press('KeyS');
    await page.scroll([changed]);
    changed.src = changed.currentSrc = 'https://x.example/c.jpg';
    page.press('KeyS');
    assert.equal(page.observed.has(changed), false);
    assert.deepEqual(page.hashed, ['https://x.example/b.jpg']);
});

test('limit: removing one of two matching images leaves the survivor\'s count and pill', async () => {
    const page = loadPage({ 'https://x.example/a.jpg': BASE, 'https://x.example/b.jpg': BASE });
    const a = page.addImage('https://x.example/a.jpg');
    const b = page.addImage('https://x.example/b.jpg');
    await page.settle();
    const [pill] = pillOf(a);
    const [stripe] = stripeOf(a);

    b.parentElement.remove();
    page.mutate();
    page.runTimers();
    page.press('KeyS');
    assertMarked(a, 2);
    assert.equal(pillOf(a)[0], pill);
    assert.equal(stripeOf(a)[0], stripe);
});
