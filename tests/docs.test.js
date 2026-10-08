// Run with: node --test tests/*.test.js
// The manifest, the README, and the content.js header comment, which is the
// behavior spec: these fail if it drops a fact the code relies on. The tests in
// content.test.js check the code does what the header says.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

// The leading /** ... */ block of extension/content.js, as one line of words.
function contentHeader() {
    const source = read('extension/content.js');
    const match = source.match(/^\/\*\*([\s\S]*?)\*\//);
    assert.ok(match, 'content.js starts with a /** header comment */');
    return match[1].replace(/^\s*\*\s?/gm, '').replace(/\s+/g, ' ');
}

test('content.js header states the behavior spec', () => {
    const header = contentHeader();
    const facts = {
        'click to start': /Nothing runs until you click the toolbar button/,
        'top frame only': /top frame only/,
        'threshold 5': /within Hamming distance 5 \(HAMMING_THRESHOLD\)/,
        'same URL twice': /same URL twice is not a duplicate/,
        'first match, no chaining': /first stored hash within 5 bits.*do not chain/,
        'size gate': /naturalWidth > 100 and naturalHeight > 50/,
        'data: and no src skipped': /no src, data: URLs/,
        'all 0 or all f skipped': /all 0 or all f/,
        'stripe class': /div\.dih-stripe/,
        'pill class': /div\.dih-count/,
        'hue formula': /t = \(min\(N, 10\) - 1\) \/ 9, hue = 200 - 200 \* t/,
        'stripe width': /20 - 15 \* t pixels/,
        'reset shortcut': /Alt\+Shift\+R: forget every hash and failure, and reload/,
        'debug shortcut': /Alt\+Shift\+D: log a debug dump/,
        'rescan shortcut': /Alt\+Shift\+S: run the observe pass again/,
        'one hash per URL in flight': /A URL is hashed once at a time/,
        'removed before view unwatched': /An image removed from the page before it came near the viewport is no longer watched\./,
        'idempotent decoration': /Only the parent's direct-child stripe and pill belong to its image/,
        'limit: watched once': /before its pixels decoded is never watched again: there is no load listener, and a changed src is not hashed/,
        'limit: counts never shrink': /Counts never shrink: removing an image from the page leaves the count and pill/
    };
    for (const [fact, pattern] of Object.entries(facts)) {
        assert.match(header, pattern, `header lost: ${fact}`);
    }
});

test('manifest: MV3, click to run, no content_scripts', () => {
    const manifest = JSON.parse(read('extension/manifest.json'));
    assert.equal(manifest.manifest_version, 3);
    assert.equal(manifest.name, 'Duplicate Image Highlighter');
    assert.equal(manifest.version, '0.1.0');
    assert.equal('content_scripts' in manifest, false);
    assert.deepEqual(manifest.permissions, ['scripting']);
    assert.equal(manifest.background.service_worker, 'background.js');
    assert.ok(manifest.action);
});

test('README: license line, spec pointer, and the stripe overlay screenshot with its caption', () => {
    const readme = read('README.md');
    const lines = readme.split('\n');
    assert.ok(lines.some((line) => line.includes('Copyright (c) 2026 Erik Sjaastad')));
    assert.match(readme, /\[MIT\]\(LICENSE\)/);
    assert.match(read('LICENSE'), /Copyright \(c\) 2026 Erik Sjaastad/);

    assert.match(readme, /extension\/content\.js/);
    assert.match(readme, /!\[[^\]]+\]\(docs\/images\/dih-readme\.png\)/);
    assert.ok(lines.includes('Four copies of the same picture get a stripe and a count of 4. ' +
        'A different picture stays unmarked.'), 'README lost the image caption');
    assert.ok(fs.statSync(path.join(ROOT, 'docs/images/dih-readme.png')).size > 0);
});
