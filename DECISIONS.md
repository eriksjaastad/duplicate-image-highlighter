# Design decisions

Short records of choices that shape the extension, and why. Newest first.

## Groups are recomputed from the images on the page (0.1.0)

**Decision.** `extension/groups.js` keeps three things: which `<img>` elements are on the page and the URL each shows (replaced on every page scan), a bounded URL → hash cache, and a graph linking hashes that differ by at most 5 bits. Duplicate groups are the connected components of that graph, restricted to URLs currently on the page. Outlines and the toolbar count are redrawn from that result.

**Why.** Adding each new hash to the first existing group it matched made the result depend on the order images loaded (A~B and B~C, but A and C too far apart), and a group never shrank when an image was removed or changed its `src`. Recomputing from the live page fixes both, and keeps the cache from evicting URLs that are still shown.

**Cost.** Each new hash is compared with every cached hash once (early exit past the threshold); the per-update recomputation is linear in the images on the page.

## Only the top frame is scanned (0.1.0)

**Decision.** The toolbar click injects into the clicked tab's top frame only. Images inside iframes are not compared, and the README says so.

**Why.** Comparing across frames needs one collector per tab. Every frame is an isolated script instance, so hashes would have to travel to the service worker and highlight instructions back to each frame. An MV3 service worker is stopped after about 30 seconds idle, so that collector would also need persisting (`chrome.storage.session`) and rebuilding. Injecting into all frames also means running inside every advert and embed on the page, not just the content the user is looking at. Scanning each frame on its own (the cheap version) would be worse than not scanning it: it would miss every cross-frame duplicate while appearing to cover iframes.

The galleries, grids and search results this is built for put their images in the top document. If a real page needs iframe coverage, build the per-tab collector then, with the persistence above, rather than a half measure now.

## Runs only when the toolbar button is clicked (0.1.0)

**Decision.** No `content_scripts` in the manifest. The service worker injects `hash.js`, `groups.js` and `content.js` with `chrome.scripting.executeScript` when the button is clicked; clicking again rescans.

**Why.** Nothing runs on pages the user did not ask about, there are no per-site match patterns to maintain, and all state lives in that tab's injected instance, so tabs cannot affect each other. Host access to `http(s)` is still needed so the service worker can fetch cross-origin images and read their pixels.
