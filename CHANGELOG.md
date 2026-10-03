# Changelog

## 0.1.0 (unreleased)

First public release.

- Marks `<img>` elements that look like other images on the current page, using a 32×32 difference hash and a Hamming-distance threshold of 5. Different URLs only: the same URL twice is not a duplicate.
- A new hash joins the first stored hash within 5 bits, in the order hashes arrive.
- Each duplicate gets a striped overlay and a count pill on its parent, colored blue for 2 copies through red for 10 or more, plus an outline on the image.
- Skips images with no `src`, `data:` URLs, images 100×50 pixels or smaller, and flat placeholders.
- Hashes images as they come within 500px of the viewport, at most 5 at a time, and picks up images added later (infinite scroll, single-page apps).
- Runs only when you click the toolbar button, in the top frame of that tab. Clicking again rescans. Pages that refuse injection get a `×` badge.
- Shortcuts: Alt+Shift+R resets and reloads, Alt+Shift+D logs a debug dump, Alt+Shift+S rescans.
- Image fetches go through the service worker without cookies, accept only `http(s)` URLs and image (or unlabeled) content types, time out after 15 seconds, and skip images over 20 MB.
- Each GitHub Release carries a zip of the extension, ready for **Load unpacked**.
