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
