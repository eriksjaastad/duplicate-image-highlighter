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

function git(dir, ...args) {
    const result = spawnSync('git', ['-C', dir, '-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], {
        encoding: 'utf8',
        timeout: 30000
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
}

// A throwaway git repo with the script, the extension and the given CHANGELOG, committed.
function fixture(changelog = CHANGELOG, version = '0.1.0') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dih-package-'));
    fs.cpSync(path.join(ROOT, 'scripts'), path.join(dir, 'scripts'), { recursive: true });
    fs.cpSync(path.join(ROOT, 'extension'), path.join(dir, 'extension'), { recursive: true });
    const manifestPath = path.join(dir, 'extension', 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.version = version;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 4));
    fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), changelog);
    git(dir, 'init', '-q');
    git(dir, 'add', 'scripts', 'extension', 'CHANGELOG.md');
    git(dir, 'commit', '-q', '-m', 'fixture');
    return dir;
}

function zipEntries(zip) {
    const listing = spawnSync('unzip', ['-Z1', zip], { encoding: 'utf8', timeout: 30000 });
    assert.equal(listing.error, undefined);
    assert.equal(listing.status, 0, listing.stderr);
    return listing.stdout.trim().split('\n').filter((f) => !f.endsWith('/')).sort();
}

function run(dir, ...args) {
    return runIn(dir, process.env.TZ, ...args);
}

function runIn(dir, tz, ...args) {
    return runWith(dir, tz ? { TZ: tz } : { TZ: undefined }, ...args);
}

// Runs package.sh with extra environment; an undefined value removes that variable.
function runWith(dir, extraEnv, ...args) {
    const out = path.join(dir, 'out');
    const env = { ...process.env, OUT_DIR: out };
    for (const [key, value] of Object.entries(extraEnv)) {
        if (value === undefined) delete env[key]; else env[key] = value;
    }
    const result = spawnSync('bash', [path.join(dir, 'scripts', 'package.sh'), ...args], {
        env,
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

    const files = zipEntries(zip);
    const expected = fs.readdirSync(path.join(ROOT, 'extension'))
        .filter((f) => f !== '.gitattributes')
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

test('packages a CHANGELOG over 100 KB under pipefail and keeps only the target section', () => {
    const changelog = '# Changelog\n\n## 0.1.0 (2026-10-02)\n\n- First.\n\n' +
        '## 0.0.1 (2026-09-01)\n\n' + '- Older release entry.\n'.repeat(16384);
    assert.ok(Buffer.byteLength(changelog) > 100 * 1024);
    // package.sh enables pipefail, so an early AWK exit would reject this history.
    const { status, stderr, out } = run(fixture(changelog), '0.1.0');
    assert.equal(status, 0, stderr);
    assert.ok(fs.existsSync(path.join(out, 'duplicate-image-highlighter-0.1.0.zip')));
    assert.equal(fs.readFileSync(path.join(out, 'release-notes.md'), 'utf8'), '- First.\n');
});

test('refuses when the manifest version differs from the tag', () => {
    const { status, stderr } = run(fixture(), '0.2.0');
    assert.equal(status, 1);
    assert.match(stderr, /manifest\.json at HEAD says 0\.1\.0, not 0\.2\.0/);
});

test('packages the committed extension only, not local edits or untracked files', () => {
    const dir = fixture();
    fs.writeFileSync(path.join(dir, 'extension', '.DS_Store'), 'junk');
    fs.appendFileSync(path.join(dir, 'extension', 'content.js'), '\n// uncommitted edit\n');
    const { status, stderr, out } = run(dir, '0.1.0');
    assert.equal(status, 0, stderr);
    const zip = path.join(out, 'duplicate-image-highlighter-0.1.0.zip');
    assert.equal(zipEntries(zip).some((f) => f.endsWith('.DS_Store')), false);
    const packed = spawnSync('unzip', ['-p', zip, 'duplicate-image-highlighter-0.1.0/content.js'], { encoding: 'utf8', timeout: 30000 });
    assert.equal(packed.status, 0);
    assert.equal(packed.stdout.includes('uncommitted edit'), false);
});

test('two builds of the same commit are byte-identical', () => {
    const dir = fixture();
    const first = run(dir, '0.1.0');
    assert.equal(first.status, 0, first.stderr);
    const zip = path.join(first.out, 'duplicate-image-highlighter-0.1.0.zip');
    const bytes = fs.readFileSync(zip);
    fs.utimesSync(path.join(dir, 'extension', 'hash.js'), new Date(), new Date());
    // Entry times must not come from the clock: wait past the zip format's 2-second resolution.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2100);
    const second = run(dir, '0.1.0');
    assert.equal(second.status, 0, second.stderr);
    assert.equal(Buffer.compare(bytes, fs.readFileSync(zip)), 0);
    const times = spawnSync('unzip', ['-Z', '-T', zip], { encoding: 'utf8', timeout: 30000 });
    assert.equal(times.status, 0);
    const commitTime = git(dir, 'log', '-1', '--format=%cd', '--date=format-local:%Y%m%d.%H%M').trim();
    assert.ok(times.stdout.includes(commitTime), `entries stamped with the commit time ${commitTime}`);
});

test('builds the same bytes in any timezone', () => {
    const dir = fixture();
    const zip = (out) => fs.readFileSync(path.join(out, 'duplicate-image-highlighter-0.1.0.zip'));
    const east = runIn(dir, 'Asia/Kolkata', '0.1.0');
    assert.equal(east.status, 0, east.stderr);
    const bytes = zip(east.out);
    const west = runIn(dir, 'America/Los_Angeles', '0.1.0');
    assert.equal(west.status, 0, west.stderr);
    assert.equal(Buffer.compare(bytes, zip(west.out)), 0);
});

test('builds the same bytes when the machine converts line endings', () => {
    const dir = fixture();
    const zipPath = (out) => path.join(out, 'duplicate-image-highlighter-0.1.0.zip');
    const plain = runWith(dir, { GIT_CONFIG_COUNT: undefined }, '0.1.0');
    assert.equal(plain.status, 0, plain.stderr);
    const bytes = fs.readFileSync(zipPath(plain.out));
    const packed = spawnSync('unzip', ['-p', zipPath(plain.out), 'duplicate-image-highlighter-0.1.0/content.js'], { timeout: 30000 });
    assert.equal(packed.status, 0);
    assert.equal(packed.stdout.includes(0x0d), false, 'packaged with LF line endings');

    // Config a Windows checkout or a global attributes file would bring, which
    // without the guards makes git archive write every file with CRLF.
    const attributes = path.join(dir, 'global-attributes');
    fs.writeFileSync(attributes, '* text eol=crlf\n');
    const converting = runWith(dir, {
        GIT_CONFIG_COUNT: '3',
        GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'true',
        GIT_CONFIG_KEY_1: 'core.eol', GIT_CONFIG_VALUE_1: 'crlf',
        GIT_CONFIG_KEY_2: 'core.attributesFile', GIT_CONFIG_VALUE_2: attributes
    }, '0.1.0');
    assert.equal(converting.status, 0, converting.stderr);
    assert.equal(Buffer.compare(bytes, fs.readFileSync(zipPath(converting.out))), 0);

    // package.sh's own overrides hold even without extension/.gitattributes.
    const bare = fixture();
    git(bare, 'rm', '-q', 'extension/.gitattributes');
    git(bare, 'commit', '-q', '-m', 'no attributes');
    const bareBuild = runWith(bare, { GIT_CONFIG_COUNT: undefined }, '0.1.0');
    assert.equal(bareBuild.status, 0, bareBuild.stderr);
    const bareBytes = fs.readFileSync(zipPath(bareBuild.out));
    const bareConverting = runWith(bare, {
        GIT_CONFIG_COUNT: '2',
        GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'true',
        GIT_CONFIG_KEY_1: 'core.eol', GIT_CONFIG_VALUE_1: 'crlf'
    }, '0.1.0');
    assert.equal(bareConverting.status, 0, bareConverting.stderr);
    assert.equal(Buffer.compare(bareBytes, fs.readFileSync(zipPath(bareConverting.out))), 0);
});

test('accepts CRLF line endings and trailing whitespace on the heading', () => {
    const changelog = '# Changelog\r\n\r\n## 0.1.0 (2026-10-02)  \r\n\r\n- First.\r\n';
    const { status, stderr, out } = run(fixture(changelog), '0.1.0');
    assert.equal(status, 0, stderr);
    assert.equal(fs.readFileSync(path.join(out, 'release-notes.md'), 'utf8'), '- First.\n');
});

test('refuses an empty CHANGELOG section', () => {
    const { status, stderr } = run(fixture('# Changelog\n\n## 0.1.0 (2026-10-02)\n\n## 0.0.1 (2026-09-01)\n\n- Old.\n'), '0.1.0');
    assert.equal(status, 1);
    assert.match(stderr, /is empty/);
});

test('refuses an undated or missing CHANGELOG section', () => {
    const undated = run(fixture('# Changelog\n\n## 0.1.0 (unreleased)\n\n- First.\n'), '0.1.0');
    assert.equal(undated.status, 1);
    assert.match(undated.stderr, /needs a section headed exactly/);
    assert.equal(fs.existsSync(undated.out), false, 'nothing built');

    const missing = run(fixture('# Changelog\n'), '0.1.0');
    assert.equal(missing.status, 1);
});

test('refuses release headings with extra labels, text or spaces', () => {
    for (const heading of [
        '## 0.1.0 (unreleased) (2026-10-02)',
        '## 0.1.0 (2026-10-02) extra',
        '## 0.1.0  (2026-10-02)'
    ]) {
        const { status, stderr, out } = run(fixture(`# Changelog\n\n${heading}\n\n- First.\n`), '0.1.0');
        assert.equal(status, 1, heading);
        assert.match(stderr, /needs a section headed exactly: ## 0\.1\.0 \(YYYY-MM-DD\)/);
        assert.equal(fs.existsSync(out), false, 'nothing built');
    }
});

test('refuses a version that is not major.minor.patch', () => {
    for (const bad of ['', 'v0.1.0', '0.1', '0.1.0-beta']) {
        const { status } = run(fixture(), ...(bad ? [bad] : []));
        assert.equal(status, 2, `"${bad}"`);
    }
});
