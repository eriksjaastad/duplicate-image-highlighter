// Run with: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SIZE = 32;

function loadHashModule() {
    const source = fs.readFileSync(path.join(__dirname, '..', 'extension', 'hash.js'), 'utf8');
    const window = {};
    const context = {
        window,
        document: {
            createElement: () => ({ getContext: () => ({}) })
        },
        chrome: {}
    };
    vm.runInNewContext(source, context);
    return window.DuplicateImageHash;
}

// RGBA buffer filled by a brightness function of (x, y)
function pixels(brightness) {
    const data = new Uint8ClampedArray(SIZE * SIZE * 4);
    for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
            const v = brightness(x, y);
            const i = (y * SIZE + x) * 4;
            data[i] = data[i + 1] = data[i + 2] = v;
            data[i + 3] = 255;
        }
    }
    return data;
}

const hasher = loadHashModule();

test('hash is 248 hex chars (32 rows x 31 comparisons = 992 bits)', () => {
    const hash = hasher.dHashFromPixels(pixels((x) => x * 8), SIZE);
    assert.equal(hash.length, 248);
    assert.match(hash, /^[0-9a-f]+$/);
});

test('left-to-right brightening gradient hashes to all zero bits', () => {
    assert.match(hasher.dHashFromPixels(pixels((x) => x * 8), SIZE), /^0+$/);
});

test('left-to-right darkening gradient hashes to all one bits', () => {
    assert.match(hasher.dHashFromPixels(pixels((x) => 255 - x * 8), SIZE), /^f+$/);
});

test('uniform brightness shift leaves the hash unchanged', () => {
    const pattern = (x, y) => ((x * 7 + y * 13) % 50) + 100;
    const a = hasher.dHashFromPixels(pixels(pattern), SIZE);
    const b = hasher.dHashFromPixels(pixels((x, y) => pattern(x, y) + 40), SIZE);
    assert.equal(hasher.hammingDistance(a, b), 0);
});

test('a small local change stays within the default threshold of 5', () => {
    const pattern = (x, y) => ((x * 7 + y * 13) % 50) + 100;
    const a = hasher.dHashFromPixels(pixels(pattern), SIZE);
    const b = hasher.dHashFromPixels(pixels((x, y) => (x === 10 && y === 10 ? 255 : pattern(x, y))), SIZE);
    const d = hasher.hammingDistance(a, b);
    assert.ok(d > 0 && d <= 5, `distance ${d}`);
});

test('unrelated images are far apart', () => {
    const a = hasher.dHashFromPixels(pixels((x) => x * 8), SIZE);
    const b = hasher.dHashFromPixels(pixels((x) => 255 - x * 8), SIZE);
    assert.equal(hasher.hammingDistance(a, b), 992);
});

test('binToHex pads a short final chunk on the right', () => {
    assert.equal(hasher.binToHex('1111'), 'f');
    assert.equal(hasher.binToHex('101'), 'a');
    assert.equal(hasher.binToHex('11110001'), 'f1');
});

test('each bit compares a pixel with its right neighbour, row by row, 31 bits per row', () => {
    // Pixel (0, 0) brighter than (1, 0): bit 0 is the top bit of hex digit 0.
    assert.equal(hasher.dHashFromPixels(pixels((x, y) => (x === 0 && y === 0 ? 255 : 0)), SIZE), '8' + '0'.repeat(247));
    // Pixel (0, 1): bit 31 is the bottom bit of hex digit 7.
    assert.equal(hasher.dHashFromPixels(pixels((x, y) => (x === 0 && y === 1 ? 255 : 0)), SIZE), '0'.repeat(7) + '1' + '0'.repeat(240));
    // Pixel (31, 0) has no right neighbour; it only makes bit 30 (left 0 < right 255) a 0.
    assert.equal(hasher.dHashFromPixels(pixels((x, y) => (x === 31 && y === 0 ? 255 : 0)), SIZE), '0'.repeat(248));
});

test('a bit is 1 only when the left RGB average is strictly greater', () => {
    // Bit 0 (top bit of hex digit 0) for [r, g, b] at pixels (0, 0) and (1, 0).
    function bit0(left, right) {
        const data = pixels(() => 0);
        data.set(left, 0);
        data.set(right, 4);
        return parseInt(hasher.dHashFromPixels(data, SIZE)[0], 16) >> 3;
    }
    assert.equal(bit0([90, 0, 0], [0, 0, 89]), 1); // 30 > 29.67
    assert.equal(bit0([90, 0, 0], [0, 0, 90]), 0); // equal averages
    assert.equal(bit0([0, 30, 0], [10, 10, 10]), 0); // 10 vs 10
    assert.equal(bit0([0, 0, 1], [0, 0, 0]), 1); // 0.33 > 0
});

test('hammingDistance is the popcount of the XOR of each hex digit', () => {
    assert.equal(hasher.hammingDistance('00', '00'), 0);
    assert.equal(hasher.hammingDistance('8', '1'), 2);
    assert.equal(hasher.hammingDistance('a5', '5a'), 8);
    assert.equal(hasher.hammingDistance('0f', '00'), 4);
    assert.equal(hasher.hammingDistance('ff', '00'), 8);
});

test('hammingDistance refuses to compare missing or mismatched hashes', () => {
    assert.equal(hasher.hammingDistance('', 'ab'), Infinity);
    assert.equal(hasher.hammingDistance(null, 'ab'), Infinity);
    assert.equal(hasher.hammingDistance('abc', 'ab'), Infinity);
});

test('re-injecting the module keeps the first instance', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'extension', 'hash.js'), 'utf8');
    const first = { marker: true };
    const window = { DuplicateImageHash: first };
    vm.runInNewContext(source, { window, document: {}, chrome: {} });
    assert.equal(window.DuplicateImageHash, first);
});

// hash.js with a recording fake canvas; `extra` adds globals (createImageBitmap, Image, ...).
// Options: `dataUrl` replaces what the service worker returns; `drawThrows` makes drawImage throw.
function loadWithCanvas({ dataUrl = 'data:image/png;base64,AQID', drawThrows = null, ...extra } = {}) {
    const calls = [];
    const ctx = {
        set fillStyle(v) { calls.push(['fillStyle', v]); },
        fillRect: (...a) => calls.push(['fillRect', ...a]),
        clearRect: (...a) => calls.push(['clearRect', ...a]),
        drawImage: (img) => {
            if (drawThrows) throw drawThrows;
            calls.push(['drawImage', img.kind]);
        },
        getImageData: () => ({ data: pixels((x) => x * 8) })
    };
    const source = fs.readFileSync(path.join(__dirname, '..', 'extension', 'hash.js'), 'utf8');
    const window = {};
    vm.runInNewContext(source, {
        window, atob, Blob, Uint8Array,
        document: { createElement: () => ({ getContext: () => ctx }) },
        chrome: { runtime: { sendMessage: (msg, cb) => cb({ success: true, dataUrl }) } },
        ...extra
    });
    return { hasher: window.DuplicateImageHash, calls };
}

class FakeImage {
    constructor() { this.kind = 'Image'; FakeImage.made++; }
    set src(v) { this.loaded = v; setImmediate(() => this.onload()); }
}
FakeImage.made = 0;

test('images are drawn on a cleared canvas with no white fill or other matte', async () => {
    let closed = false;
    const { hasher, calls } = loadWithCanvas({
        createImageBitmap: async () => ({ kind: 'bitmap', close: () => { closed = true; } })
    });
    const hash = await hasher.queueHash('https://x.example/a.png');
    assert.equal(typeof hash, 'string');
    assert.equal(hash.length, 248);
    assert.deepEqual(calls, [['clearRect', 0, 0, SIZE, SIZE], ['drawImage', 'bitmap']]);
    assert.equal(closed, true, 'bitmap released');
});

test('the bitmap path and the Image path draw the same way, so they hash the same', async () => {
    const bitmap = loadWithCanvas({ createImageBitmap: async () => ({ kind: 'bitmap', close() {} }) });
    const image = loadWithCanvas({
        Image: FakeImage,
        createImageBitmap: async () => { throw new Error('The source image could not be decoded.'); }
    });
    const a = await bitmap.hasher.queueHash('https://x.example/a.png');
    const b = await image.hasher.queueHash('https://x.example/a.png');
    assert.equal(a, b);
    const ops = (calls) => calls.map(([op, ...args]) => [op, ...(op === 'drawImage' ? [] : args)]);
    assert.deepEqual(ops(bitmap.calls), ops(image.calls));
});

test('at most 5 hashes run at once; the rest wait in the queue', async () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'extension', 'hash.js'), 'utf8');
    const window = {};
    const requested = [];
    vm.runInNewContext(source, {
        window,
        document: { createElement: () => ({ getContext: () => ({}) }) },
        chrome: { runtime: { sendMessage: (msg) => requested.push(msg.url) } } // never answers
    });
    for (let i = 0; i < 8; i++) window.DuplicateImageHash.queueHash(`https://x.example/${i}.png`);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(requested, [0, 1, 2, 3, 4].map((i) => `https://x.example/${i}.png`));
});

test('a failed fetch resolves to null', async () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'extension', 'hash.js'), 'utf8');
    const window = {};
    vm.runInNewContext(source, {
        window,
        document: { createElement: () => ({ getContext: () => ({}) }) },
        chrome: { runtime: { sendMessage: (msg, cb) => cb({ success: false, error: 'HTTP 404' }) } }
    });
    assert.equal(await window.DuplicateImageHash.queueHash('https://x.example/gone.png'), null);
});

test('raster images decode from a Blob, never through a data URL in the page', async () => {
    const blobs = [];
    FakeImage.made = 0;
    const { hasher } = loadWithCanvas({
        Image: FakeImage,
        createImageBitmap: async (blob) => { blobs.push(blob); return { kind: 'bitmap', close() {} }; }
    });
    await hasher.queueHash('https://x.example/a.png');
    assert.equal(FakeImage.made, 0);
    assert.equal(blobs[0].type, 'image/png');
    assert.deepEqual([...new Uint8Array(await blobs[0].arrayBuffer())], [1, 2, 3]);
});

test('formats createImageBitmap cannot decode fall back to the data URL', async () => {
    FakeImage.made = 0;
    const { hasher, calls } = loadWithCanvas({
        Image: FakeImage,
        createImageBitmap: async () => { throw new Error('The source image could not be decoded.'); }
    });
    const hash = await hasher.queueHash('https://x.example/a.svg');
    assert.equal(hash.length, 248);
    assert.equal(FakeImage.made, 1);
    assert.deepEqual(calls.at(-1), ['drawImage', 'Image']);
});

test('when both decoders fail, the hash is null and the warning names both causes', async () => {
    const warnings = [];
    class FailingImage {
        set src(v) { setImmediate(() => this.onerror({ type: 'error' })); }
    }
    const { hasher, calls } = loadWithCanvas({
        Image: FailingImage,
        console: { warn: (...a) => warnings.push(a.map(String).join(' ')) },
        createImageBitmap: async () => { throw new Error('The source image could not be decoded.'); }
    });
    assert.equal(await hasher.queueHash('https://x.example/a.svg'), null);
    assert.equal(calls.length, 0, 'nothing drawn');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /as a bitmap: The source image could not be decoded\.; as an Image: error event/);
});

test('a bitmap is released even when drawing it throws', async () => {
    let closed = false;
    const warnings = [];
    const { hasher } = loadWithCanvas({
        drawThrows: new Error('The image source is detached'),
        console: { warn: (...a) => warnings.push(a) },
        createImageBitmap: async () => ({ kind: 'bitmap', close: () => { closed = true; } })
    });
    assert.equal(await hasher.queueHash('https://x.example/a.png'), null);
    assert.equal(closed, true, 'bitmap released');
    assert.equal(warnings.length, 1);
});

test('a data URL that is not valid base64 falls back to the Image decoder', async () => {
    FakeImage.made = 0;
    let bitmapCalls = 0;
    const { hasher, calls } = loadWithCanvas({
        Image: FakeImage,
        createImageBitmap: async () => { bitmapCalls++; return { kind: 'bitmap', close() {} }; },
        dataUrl: 'data:image/svg+xml;charset=utf-8,<svg xmlns="http://www.w3.org/2000/svg"/>'
    });
    const hash = await hasher.queueHash('https://x.example/a.svg');
    assert.equal(hash.length, 248);
    assert.equal(bitmapCalls, 0, 'atob rejected the payload before createImageBitmap ran');
    assert.equal(FakeImage.made, 1);
    assert.deepEqual(calls.at(-1), ['drawImage', 'Image']);
});
