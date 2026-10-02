#!/usr/bin/env bash
# Build the release zip for a version and its release notes, from the
# committed HEAD (uncommitted and untracked files are never packaged).
#
#   scripts/package.sh 0.1.0            # writes dist/duplicate-image-highlighter-0.1.0.zip
#   OUT_DIR=/some/dir scripts/package.sh 0.1.0
#
# Refuses unless HEAD's extension/manifest.json has that version and HEAD's
# CHANGELOG.md has a non-empty "## <version> (YYYY-MM-DD)" section, so a tag
# cannot ship stale metadata. Writes release-notes.md (that section) next to the zip.
set -euo pipefail

version="${1:-}"
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "usage: $0 <major.minor.patch>" >&2
    exit 2
fi

root="$(cd "$(dirname "$0")/.." && pwd)"
out="${OUT_DIR:-$root/dist}"

manifest_version="$(git -C "$root" show HEAD:extension/manifest.json | node -e '
    let s = ""; process.stdin.on("data", (d) => { s += d; });
    process.stdin.on("end", () => console.log(JSON.parse(s).version));
')"
if [[ "$manifest_version" != "$version" ]]; then
    echo "extension/manifest.json at HEAD says $manifest_version, not $version" >&2
    exit 1
fi

# The section under "## <version> (YYYY-MM-DD)", up to the next "## " heading.
# Tolerates CRLF line endings and trailing whitespace.
notes="$(git -C "$root" show HEAD:CHANGELOG.md | awk -v v="$version" '
    { sub(/\r$/, ""); sub(/[ \t]+$/, "") }
    index($0, "## " v " (") == 1 {
        if ($0 !~ /\([0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]\)$/) { bad = 1; exit }
        found = 1; next
    }
    found && /^## / { exit }
    found { print }
    END { if (bad || !found) exit 1 }
' | sed '/./,$!d')" || {
    echo "CHANGELOG.md at HEAD needs a section headed exactly: ## $version (YYYY-MM-DD)" >&2
    exit 1
}
if [[ -z "${notes//[[:space:]]/}" ]]; then
    echo "CHANGELOG.md section for $version is empty" >&2
    exit 1
fi

name="duplicate-image-highlighter-$version"
mkdir -p "$out"
git -C "$root" archive --format=zip --prefix="$name/" -o "$out/$name.zip" HEAD:extension
printf '%s\n' "$notes" > "$out/release-notes.md"

echo "$out/$name.zip"
