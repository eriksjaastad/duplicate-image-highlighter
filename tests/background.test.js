// Run with: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'extension', 'background.js'), 'utf8');
const EXTENSION_ID = 'test-extension';

// Loads background.js with a stubbed chrome API and the given fetch.
function loadBackground(fetchImpl, { executeScript, timers = { setTimeout, clearTimeout } } = {}) {
    const listeners = {};
    const badge = [];
    const injected = [];
    const chrome = {
        runtime: {
            id: EXTENSION_ID,
            onMessage: { addListener: (fn) => { listeners.message = fn; } }
        },
        action: {
            onClicked: { addListener: (fn) => { listeners.click = fn; } },
            setBadgeText: async (opts) => { badge.push(['text', opts]); },
            setBadgeBackgroundColor: async (opts) => { badge.push(['color', opts]); }
        },
        tabs: { onUpdated: { addListener: (fn) => { listeners.updated = fn; } } },
        scripting: { executeScript: executeScript || (async (opts) => { injected.push(opts); }) }
    };
    class FileReader {
        readAsDataURL(blob) {
            blob.arrayBuffer().then((buf) => {
                this.result = `data:${blob.type};base64,${Buffer.from(buf).toString('base64')}`;
                this.onloadend();
            });
        }
    }
    vm.runInNewContext(SOURCE, {
        chrome, fetch: fetchImpl, FileReader, URL, AbortController, Number,
        setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
        console: { warn() {}, log() {} }
    });
    return { listeners, badge, injected };
}

function imageResponse(bytes, headers = {}) {
    const type = headers['Content-Type'] ?? 'image/png';
    return {
        ok: true,
        status: 200,
        headers: { get: (name) => headers[name] ?? (name === 'Content-Type' ? type : null) },
        blob: async () => new Blob([bytes], { type })
    };
}

const tabSender = { id: EXTENSION_ID, tab: { id: 7 } };

// Sends a FETCH_IMAGE_BLOB message and resolves with the response.
function requestImage(listeners, url, sender = tabSender) {
    return new Promise((resolve) => {
        const keepOpen = listeners.message({ action: 'FETCH_IMAGE_BLOB', url }, sender, resolve);
        assert.equal(keepOpen, true);
    });
}

test('fetches an image as a data URL without cookies', async () => {
    const calls = [];
    const { listeners } = loadBackground(async (url, opts) => {
        calls.push({ url, opts });
        return imageResponse(new Uint8Array([1, 2, 3]));
    });
    const res = await requestImage(listeners, 'https://img.example/a.png');
    assert.equal(res.success, true);
    assert.equal(res.dataUrl, 'data:image/png;base64,AQID');
    assert.equal(calls[0].opts.credentials, 'omit');
});

test('refuses non-http(s) URLs without fetching', async () => {
    let fetched = false;
    const { listeners } = loadBackground(async () => { fetched = true; });
    for (const url of ['file:///etc/hosts', 'chrome://settings', 'data:image/png;base64,AA']) {
        const res = await requestImage(listeners, url);
        assert.equal(res.success, false, url);
    }
    assert.equal(fetched, false);
});

test('refuses a declared non-image content type', async () => {
    const { listeners } = loadBackground(async () => imageResponse('<html>', { 'Content-Type': 'text/html' }));
    const res = await requestImage(listeners, 'https://img.example/page');
    assert.equal(res.success, false);
    assert.match(res.error, /Not an image/);
});

test('accepts octet-stream and missing content types (decoding decides)', async () => {
    for (const type of ['application/octet-stream', '']) {
        const { listeners } = loadBackground(async () => imageResponse(new Uint8Array([1]), { 'Content-Type': type }));
        const res = await requestImage(listeners, 'https://img.example/x');
        assert.equal(res.success, true, `type "${type}"`);
    }
});

test('refuses an oversized image from Content-Length before reading the body', async () => {
    let bodyRead = false;
    const { listeners } = loadBackground(async () => ({
        ok: true,
        status: 200,
        headers: { get: (n) => ({ 'Content-Length': String(50 * 1024 * 1024), 'Content-Type': 'image/png' })[n] ?? null },
        blob: async () => { bodyRead = true; return new Blob([]); }
    }));
    const res = await requestImage(listeners, 'https://img.example/huge.png');
    assert.equal(res.success, false);
    assert.match(res.error, /too large/);
    assert.equal(bodyRead, false);
});

test('refuses an oversized body when no Content-Length was sent', async () => {
    const big = new Uint8Array(20 * 1024 * 1024 + 1);
    const { listeners } = loadBackground(async () => imageResponse(big));
    const res = await requestImage(listeners, 'https://img.example/big.png');
    assert.equal(res.success, false);
    assert.match(res.error, /too large/);
});

test('reports HTTP errors as failures', async () => {
    const { listeners } = loadBackground(async () => ({ ok: false, status: 403, headers: { get: () => null } }));
    const res = await requestImage(listeners, 'https://img.example/members-only.png');
    assert.equal(res.success, false);
    assert.match(res.error, /403/);
});

test('aborts a stalled fetch after the timeout', async () => {
    // Fake timers inside the service worker; the real clock bounds the test.
    const scheduled = [];
    const timers = { setTimeout: (fn, ms) => scheduled.push({ fn, ms }), clearTimeout: () => {} };
    const { listeners } = loadBackground((url, opts) => new Promise((_, reject) => {
        opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }), { timers });
    const pending = requestImage(listeners, 'https://slow.example/a.png');
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(scheduled.map((t) => t.ms), [15000]);
    scheduled[0].fn();
    const res = await Promise.race([
        pending,
        new Promise((r) => setTimeout(() => r({ success: 'stuck' }), 1000))
    ]);
    assert.equal(res.success, false, 'stalled fetch was not aborted');
    assert.match(res.error, /aborted/);
});

test('ignores messages that do not come from our own content script', () => {
    const { listeners, badge } = loadBackground(async () => { throw new Error('must not fetch'); });
    const noTab = listeners.message({ action: 'FETCH_IMAGE_BLOB', url: 'https://x.example/a.png' }, { id: EXTENSION_ID }, () => {});
    const otherExtension = listeners.message({ action: 'SCAN_STATUS', pending: 0, groups: 3 }, { id: 'other', tab: { id: 1 } }, () => {});
    assert.equal(noTab, false);
    assert.equal(otherExtension, false);
    assert.equal(badge.length, 0);
});

test('badge shows progress, then the group count', () => {
    const { listeners, badge } = loadBackground(async () => {});
    listeners.message({ action: 'SCAN_STATUS', pending: 4, groups: 1 }, tabSender, () => {});
    listeners.message({ action: 'SCAN_STATUS', pending: 0, groups: 3 }, tabSender, () => {});
    listeners.message({ action: 'SCAN_STATUS', pending: 0, groups: 0 }, tabSender, () => {});
    const texts = badge.filter(([kind]) => kind === 'text').map(([, o]) => [o.tabId, o.text]);
    assert.deepEqual(texts, [[7, '…'], [7, '3'], [7, '0']]);
});

test('toolbar click injects the hasher and scanner into the top frame only', async () => {
    const { listeners, injected } = loadBackground(async () => {});
    await listeners.click({ id: 9 });
    assert.equal(injected.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(injected[0])), {
        target: { tabId: 9 },
        files: ['hash.js', 'content.js']
    });
});

test('a page that refuses injection gets an × badge', async () => {
    const { listeners, badge } = loadBackground(async () => {}, {
        executeScript: async () => { throw new Error('Cannot access a chrome:// URL'); }
    });
    await listeners.click({ id: 4 });
    const texts = badge.filter(([kind]) => kind === 'text').map(([, o]) => [o.tabId, o.text]);
    assert.deepEqual(texts, [[4, '×']]);
});

test('navigation clears the badge', () => {
    const { listeners, badge } = loadBackground(async () => {});
    listeners.updated(5, { status: 'loading' });
    listeners.updated(5, { status: 'complete' });
    const texts = badge.filter(([kind]) => kind === 'text').map(([, o]) => [o.tabId, o.text]);
    assert.deepEqual(texts, [[5, '']]);
});
