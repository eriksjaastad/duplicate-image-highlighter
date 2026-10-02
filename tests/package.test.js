// Run with: node --test tests/*.test.js
// scripts/package.sh against a throwaway copy of the repo.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

const CHANGELOG = `# Changelog

## 0.2.0 (2026-11-01)

- Second.

## 0.1.0 (2026-10-02)

First public release.

- First.
`;

// Copies the script and extension into a temp dir with the given CHANGELOG.
function fixture(changelog = CHANGELOG, version = '0.1.0') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dih-package-'));
    fs.cpSync(path.join(ROOT, 'scripts'), path.join(dir, 'scripts'), { recursive: true });
    fs.cpSync(path.join(ROOT, 'extension'), path.join(dir, 'extension'), { recursive: true });
    const manifestPath = path.join(dir, 'extension', 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.version = version;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 4));
    fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), changelog);
    return dir;
}

function run(dir, ...args) {
    const out = path.join(dir, 'out');
    const result = spawnSync('bash', [path.join(dir, 'scripts', 'package.sh'), ...args], {
        env: { ...process.env, OUT_DIR: out },
        encoding: 'utf8',
        timeout: 30000
    });
    assert.equal(result.error, undefined);
    return { ...result, out };
}

test('builds a zip with the extension in a versioned folder, and its release notes', () => {
    const dir = fixture();
    const { status, stdout, stderr, out } = run(dir, '0.1.0');
    assert.equal(status, 0, stderr);
    const zip = path.join(out, 'duplicate-image-highlighter-0.1.0.zip');
    assert.equal(stdout.trim(), zip);

    const listing = spawnSync('unzip', ['-Z1', zip], { encoding: 'utf8', timeout: 30000 });
    assert.equal(listing.status, 0);
    const files = listing.stdout.trim().split('\n').filter((f) => !f.endsWith('/')).sort();
    const expected = fs.readdirSync(path.join(ROOT, 'extension'))
        .map((f) => `duplicate-image-highlighter-0.1.0/${f}`).sort();
    assert.deepEqual(files, expected);

    assert.equal(fs.readFileSync(path.join(out, 'release-notes.md'), 'utf8'), 'First public release.\n\n- First.\n');
});

test('release notes stop at the next version section', () => {
    const dir = fixture(CHANGELOG, '0.2.0');
    const { status, stderr, out } = run(dir, '0.2.0');
    assert.equal(status, 0, stderr);
    assert.equal(fs.readFileSync(path.join(out, 'release-notes.md'), 'utf8'), '- Second.\n');
});

test('refuses when the manifest version differs from the tag', () => {
    const { status, stderr } = run(fixture(), '0.2.0');
    assert.equal(status, 1);
    assert.match(stderr, /manifest\.json says 0\.1\.0, not 0\.2\.0/);
});

test('refuses an undated or missing CHANGELOG section', () => {
    const undated = run(fixture('# Changelog\n\n## 0.1.0 (unreleased)\n\n- First.\n'), '0.1.0');
    assert.equal(undated.status, 1);
    assert.match(undated.stderr, /needs a dated section/);
    assert.equal(fs.existsSync(undated.out), false, 'nothing built');

    const missing = run(fixture('# Changelog\n'), '0.1.0');
    assert.equal(missing.status, 1);
});

test('refuses a version that is not major.minor.patch', () => {
    for (const bad of ['', 'v0.1.0', '0.1', '0.1.0-beta']) {
        const { status } = run(fixture(), ...(bad ? [bad] : []));
        assert.equal(status, 2, `"${bad}"`);
    }
});
