// Shared by the test files. Not named *.test.js, so `node --test tests/*.test.js`
// does not run it on its own.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HASH_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'extension', 'hash.js'), 'utf8');

// Runs extension/hash.js in a fresh context and returns window.DuplicateImageHash.
// `ctx` is the canvas 2D context it draws on; other options become globals
// (chrome, createImageBitmap, Image, console, ...).
function loadHash({ window = {}, ctx = {}, chrome = {}, ...globals } = {}) {
    vm.runInNewContext(HASH_SOURCE, {
        window,
        chrome,
        document: { createElement: () => ({ getContext: () => ctx }) },
        ...globals
    });
    return window.DuplicateImageHash;
}

module.exports = { loadHash };
