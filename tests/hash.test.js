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

test('hammingDistance counts differing bits', () => {
    assert.equal(hasher.hammingDistance('00', '00'), 0);
    assert.equal(hasher.hammingDistance('0f', '00'), 4);
    assert.equal(hasher.hammingDistance('ff', '00'), 8);
});

test('hammingDistance with a limit stops early but still exceeds the limit', () => {
    const a = 'f'.repeat(248);
    const b = '0'.repeat(248);
    const d = hasher.hammingDistance(a, b, 5);
    assert.ok(d > 5 && d < 992, `distance ${d}`);
    assert.equal(hasher.hammingDistance('0f', '00', 5), 4); // within limit: exact
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

test('a flat color is solid, with or without re-encoding noise', () => {
    assert.equal(hasher.isSolidFromPixels(pixels(() => 128)), true);
    assert.equal(hasher.isSolidFromPixels(pixels((x, y) => 128 + ((x + y) % 3) - 1)), true);
});

test('a smooth gradient is not solid, though it hashes to all zero bits', () => {
    const gradient = pixels((x) => x * 8);
    assert.match(hasher.dHashFromPixels(gradient, SIZE), /^0+$/);
    assert.equal(hasher.isSolidFromPixels(gradient), false);
});

test('a pattern is not solid', () => {
    assert.equal(hasher.isSolidFromPixels(pixels((x, y) => ((x * 7 + y * 13) % 50) + 100)), false);
});

// Checkerboard of two colors given as [r, g, b].
function checkerboard(first, second) {
    const data = new Uint8ClampedArray(SIZE * SIZE * 4);
    for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
            const i = (y * SIZE + x) * 4;
            const [r, g, b] = (x + y) % 2 === 0 ? first : second;
            data[i] = r;
            data[i + 1] = g;
            data[i + 2] = b;
            data[i + 3] = 255;
        }
    }
    return data;
}

test('a pattern of equally bright colors is not solid, whichever channels vary', () => {
    assert.equal(hasher.isSolidFromPixels(checkerboard([200, 0, 0], [0, 200, 0])), false);
    assert.equal(hasher.isSolidFromPixels(checkerboard([100, 200, 0], [100, 0, 200])), false);
    assert.equal(hasher.isSolidFromPixels(checkerboard([100, 100, 0], [100, 100, 200])), false); // blue only
    assert.equal(hasher.isSolidFromPixels(checkerboard([200, 100, 0], [200, 100, 0])), true);
});

test('dropQueued removes waiting hashes, not ones in flight', async () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'extension', 'hash.js'), 'utf8');
    const window = {};
    vm.runInNewContext(source, {
        window,
        document: { createElement: () => ({ getContext: () => ({}) }) },
        chrome: { runtime: { sendMessage: () => {} } } // fetches never answer: 5 stay in flight
    });
    const h = window.DuplicateImageHash;
    const results = {};
    for (let i = 0; i < 8; i++) h.queueHash(`u${i}`).then((r) => { results[`u${i}`] = r; });
    assert.equal(h.pendingCount(), 8);

    h.dropQueued((url) => url === 'u0' || url === 'u6' || url === 'u7');
    await new Promise((r) => setImmediate(r));
    assert.equal(h.pendingCount(), 6);
    assert.deepEqual(Object.keys(results).sort(), ['u6', 'u7']);
    assert.equal(results.u6.dropped, true);
});

test('a pattern made only by transparency is not solid', () => {
    const data = new Uint8ClampedArray(SIZE * SIZE * 4); // all black
    for (let i = 0; i < SIZE * SIZE; i++) data[i * 4 + 3] = (i % SIZE) < SIZE / 2 ? 255 : 0;
    assert.equal(hasher.isSolidFromPixels(data), false);
});

test('images are drawn over white before their pixels are read', async () => {
    const calls = [];
    const ctx = {
        set fillStyle(v) { calls.push(['fillStyle', v]); },
        fillRect: (...a) => calls.push(['fillRect', ...a]),
        clearRect: (...a) => calls.push(['clearRect', ...a]),
        drawImage: () => calls.push(['drawImage']),
        getImageData: () => ({ data: pixels((x) => x * 8) })
    };
    class Image {
        set src(v) { this._src = v; setImmediate(() => this.onload()); }
    }
    const source = fs.readFileSync(path.join(__dirname, '..', 'extension', 'hash.js'), 'utf8');
    const window = {};
    vm.runInNewContext(source, {
        window,
        Image,
        document: { createElement: () => ({ getContext: () => ctx }) },
        chrome: { runtime: { sendMessage: (msg, cb) => cb({ success: true, dataUrl: 'data:image/png;base64,AA' }) } }
    });
    const result = await window.DuplicateImageHash.queueHash('https://x.example/a.png');
    assert.equal(result.hash.length, 248);
    assert.deepEqual(calls, [['fillStyle', '#fff'], ['fillRect', 0, 0, SIZE, SIZE], ['drawImage']]);
});
