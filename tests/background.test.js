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
        chrome, fetch: fetchImpl, FileReader, URL, AbortController, Number, Blob,
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
        body: new Blob([bytes]).stream()
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
        get body() { bodyRead = true; return new Blob([]).stream(); }
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

// A body of 1 MB chunks that never ends, counting what was pulled and whether the fetch was aborted.
function endlessResponse(headers = {}) {
    const state = { pulled: 0, aborted: false };
    const fetchImpl = async (url, opts) => {
        opts.signal.addEventListener('abort', () => { state.aborted = true; });
        return {
            ok: true,
            status: 200,
            headers: { get: (n) => ({ 'Content-Type': 'image/png', ...headers })[n] ?? null },
            body: new ReadableStream({
                pull(controller) {
                    state.pulled += 1024 * 1024;
                    controller.enqueue(new Uint8Array(1024 * 1024));
                }
            })
        };
    };
    return { state, fetchImpl };
}

test('stops downloading a body without Content-Length once it passes the limit', async () => {
    const { state, fetchImpl } = endlessResponse();
    const { listeners } = loadBackground(fetchImpl);
    const res = await requestImage(listeners, 'https://img.example/endless.png');
    assert.equal(res.success, false);
    assert.match(res.error, /too large/);
    assert.equal(state.aborted, true);
    assert.ok(state.pulled <= 23 * 1024 * 1024, `pulled ${state.pulled} bytes`);
});

test('stops downloading a body longer than its declared Content-Length', async () => {
    const { state, fetchImpl } = endlessResponse({ 'Content-Length': '1000' });
    const { listeners } = loadBackground(fetchImpl);
    const res = await requestImage(listeners, 'https://img.example/liar.png');
    assert.equal(res.success, false);
    assert.match(res.error, /too large/);
    assert.ok(state.pulled <= 23 * 1024 * 1024, `pulled ${state.pulled} bytes`);
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

test('ignores messages that do not come from our own content script', async () => {
    let fetched = false;
    const { listeners } = loadBackground(async () => { fetched = true; return imageResponse(new Uint8Array([1])); });
    const noTab = listeners.message({ action: 'FETCH_IMAGE_BLOB', url: 'https://x.example/a.png' }, { id: EXTENSION_ID }, () => {});
    const otherExtension = listeners.message({ action: 'FETCH_IMAGE_BLOB', url: 'https://x.example/a.png' }, { id: 'other', tab: { id: 1 } }, () => {});
    await new Promise((r) => setImmediate(r));
    assert.equal(noTab, false);
    assert.equal(otherExtension, false);
    assert.equal(fetched, false);
});

test('there is no scan-status message: the badge never shows progress or a group count', () => {
    const { listeners, badge } = loadBackground(async () => {});
    const handled = listeners.message({ action: 'SCAN_STATUS', pending: 0, groups: 3 }, tabSender, () => {});
    assert.equal(handled, false);
    assert.equal(badge.length, 0);
    assert.doesNotMatch(SOURCE, /SCAN_STATUS|'…'/);
});

test('toolbar click injects the hasher, then the page script, into the top frame only', async () => {
    const { listeners, injected, badge } = loadBackground(async () => {});
    await listeners.click({ id: 9 });
    assert.equal(injected.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(injected[0])), {
        target: { tabId: 9 },
        files: ['hash.js', 'content.js']
    });
    assert.equal(badge.length, 0);
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
