# Changelog

## 0.1.0 (unreleased)

First public release.

- Highlights duplicate and near-duplicate `<img>` elements on the current page using a 32×32 difference hash and a Hamming-distance threshold of 5.
- Runs only when you click the toolbar button, in the top frame of that tab; clicking again rescans.
- Toolbar badge shows progress (`…`), then the number of duplicate groups.
- Handles lazy-loaded images, infinite scroll and images whose `src` changes after load.
- Duplicates are marked with an outline drawn inside the image's edge, colored by how many look-alike files there are. Outlines take no space, so the page layout never moves; the image's own outline is restored when a highlight is cleared.
- Clicking again rescans and retries images that failed to load.
- Image fetches go through the service worker without cookies, accept only `http(s)` URLs and image (or unlabeled) content types, time out after 15 seconds, and skip images over 20 MB.
