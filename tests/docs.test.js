// Run with: node --test tests/*.test.js
// The manifest, the README's license line, and the content.js header comment,
// which is the behavior spec: these fail if it drops a fact the code relies on.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

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
        'rescan shortcut': /Alt\+Shift\+S: run the observe pass again/
    };
    for (const [fact, pattern] of Object.entries(facts)) {
        assert.match(header, pattern, `header lost: ${fact}`);
    }
});

test('content.js header facts match the code', () => {
    const source = read('extension/content.js');
    assert.match(source, /const HAMMING_THRESHOLD = 5;/);
    assert.match(source, /img\.naturalWidth > 100 && img\.naturalHeight > 50/);
    assert.match(source, /className = 'dih-stripe'/);
    assert.match(source, /className = 'dih-count'/);
    assert.match(source, /const hue = 200 - \(200 \* t\);/);
    assert.match(source, /rootMargin: '500px'/);
    const shortcuts = [...source.matchAll(/e\.code === '(Key\w)'/g)].map((m) => m[1]);
    assert.deepEqual(shortcuts, ['KeyR', 'KeyD', 'KeyS']);
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

test('README carries the copyright line and links the license', () => {
    const readme = read('README.md');
    assert.ok(readme.split('\n').some((line) => line.includes('Copyright (c) 2026 Erik Sjaastad')));
    assert.match(readme, /\[MIT\]\(LICENSE\)/);
    assert.match(read('LICENSE'), /Copyright \(c\) 2026 Erik Sjaastad/);
});

test('README points at the content.js header and shows no screenshot', () => {
    const readme = read('README.md');
    assert.match(readme, /extension\/content\.js/);
    assert.doesNotMatch(readme, /!\[|screenshot/i);
});

test('nothing tracked mentions the removed groups module', () => {
    const files = spawnSync('git', ['-C', ROOT, 'ls-files'], { encoding: 'utf8', timeout: 30000 });
    assert.equal(files.status, 0, files.stderr);
    const self = path.relative(ROOT, __filename);
    for (const file of files.stdout.trim().split('\n')) {
        if (file === self || !/\.(js|json|md|yml|sh)$/.test(file)) continue;
        assert.doesNotMatch(read(file), /groups\.js/, file);
    }
});
