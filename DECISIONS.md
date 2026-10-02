# Design decisions

Short records of choices that shape the extension, and why. Newest first.

## Groups are recomputed from the images on the page (0.1.0)

**Decision.** `extension/groups.js` keeps which `<img>` elements are on the page and the URL each shows (replaced on every page scan), and a bounded URL → hash cache that never evicts a URL still on the page. Two URLs match when their hashes differ by at most 5 bits; duplicate groups are the connected components of that relation among URLs currently on the page. Outlines and the toolbar count are redrawn from that result.

**Why.** Adding each new hash to the first existing group it matched made the result depend on the order images loaded (A~B and B~C, but A and C too far apart), and a group never shrank when an image was removed or changed its `src`. Recomputing from the live page fixes both, and keeps the cache from evicting URLs that are still shown.

**How it stays fast.** Comparing every hash with every other, or storing every matching pair, is quadratic: a few hundred near-identical images would stall the page. Instead the 992 bits of each hash are dealt into 6 bands (bit *p* goes to band *p* mod 6). Two hashes within 5 bits differ in at most 5 bands, so they share at least one band exactly; an index from band to hashes therefore finds every possible match. Dealing the bits, rather than cutting the hash into consecutive runs, spreads every band over the whole picture, so images that only share a flat background (identical rows of the hash) do not share a band. A union-find over the hashes on the page is extended as hashes arrive and rebuilt only when an image leaves, a pair already in the same group is not compared again, and a comparison is a popcount over 31 machine words.

Measured in Node on a laptop:

| Case | Hash comparisons | Time |
| --- | --- | --- |
| 5,000 unrelated images | 0 | rebuild under 20 ms |
| 5,000 images sharing a flat top third | 0 | rebuild under 10 ms |
| one cluster of 990 distinct near-identical images | about 2 per image | about 0.1 s to build, 0.05 s to rebuild |

What is left quadratic: many distinct images that agree exactly on one band (a sixth of their bits, spread evenly over the picture) without matching. Each such pair is compared once per build or rebuild: about 0.3 s for 2,000 synthetic images built that way. Unrelated pictures do not agree on an evenly spread sixth of their bits, so this has not been seen outside constructed data.

## Only the top frame is scanned (0.1.0)

**Decision.** The toolbar click injects into the clicked tab's top frame only. Images inside iframes are not compared, and the README says so.

**Why.** Comparing across frames needs one collector per tab. Every frame is an isolated script instance, so hashes would have to travel to the service worker and highlight instructions back to each frame. An MV3 service worker is stopped after about 30 seconds idle, so that collector would also need persisting (`chrome.storage.session`) and rebuilding. Injecting into all frames also means running inside every advert and embed on the page, not just the content the user is looking at. Scanning each frame on its own (the cheap version) would be worse than not scanning it: it would miss every cross-frame duplicate while appearing to cover iframes.

The galleries, grids and search results this is built for put their images in the top document. If a real page needs iframe coverage, build the per-tab collector then, with the persistence above, rather than a half measure now.

## Runs only when the toolbar button is clicked (0.1.0)

**Decision.** No `content_scripts` in the manifest. The service worker injects `hash.js`, `groups.js` and `content.js` with `chrome.scripting.executeScript` when the button is clicked; clicking again rescans.

**Why.** Nothing runs on pages the user did not ask about, there are no per-site match patterns to maintain, and all state lives in that tab's injected instance, so tabs cannot affect each other. Host access to `http(s)` is still needed so the service worker can fetch cross-origin images and read their pixels.
