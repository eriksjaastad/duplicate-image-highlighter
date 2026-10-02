#!/usr/bin/env bash
# Build the release zip for a version and its release notes.
#
#   scripts/package.sh 0.1.0            # writes dist/duplicate-image-highlighter-0.1.0.zip
#   OUT_DIR=/some/dir scripts/package.sh 0.1.0
#
# Refuses unless extension/manifest.json has that version and CHANGELOG.md has a
# dated "## <version> (YYYY-MM-DD)" section, so a tag cannot ship stale metadata.
# Writes release-notes.md (that CHANGELOG section) next to the zip.
set -euo pipefail

version="${1:-}"
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "usage: $0 <major.minor.patch>" >&2
    exit 2
fi

root="$(cd "$(dirname "$0")/.." && pwd)"
out="${OUT_DIR:-$root/dist}"

manifest_version="$(node -p "require('$root/extension/manifest.json').version")"
if [[ "$manifest_version" != "$version" ]]; then
    echo "extension/manifest.json says $manifest_version, not $version" >&2
    exit 1
fi

notes="$(awk -v v="$version" '
    index($0, "## " v " (") == 1 { if ($0 !~ /\([0-9]{4}-[0-9]{2}-[0-9]{2}\)$/) exit 3; found = 1; next }
    found && /^## / { exit }
    found { print }
    END { if (!found) exit 4 }
' "$root/CHANGELOG.md")" || {
    echo "CHANGELOG.md needs a dated section: ## $version (YYYY-MM-DD)" >&2
    exit 1
}

name="duplicate-image-highlighter-$version"
staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT
cp -R "$root/extension" "$staging/$name"

mkdir -p "$out"
rm -f "$out/$name.zip"
(cd "$staging" && zip -qrX "$out/$name.zip" "$name")
printf '%s\n' "$notes" | sed '/./,$!d' > "$out/release-notes.md"

echo "$out/$name.zip"
