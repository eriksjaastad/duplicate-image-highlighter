# Design decisions

Short records of choices that shape the extension, and why. Newest first.

## Page behavior is the original plugin's, made generic (0.1.0)

**Decision.** `extension/content.js` and `extension/hash.js` reproduce the original plugin's page behavior. A new hash joins the first stored hash within 5 bits, in arrival order; matches do not chain, and the result can depend on the order images are hashed. Duplicates get a striped overlay and a count pill on the image's parent, colored by count.

**Why.** That is the behavior the extension was built around. A rewrite that grouped by connected components and replaced the stripe and pill with an outline only was rejected: it changed what users see and how matches form. First-match is kept on purpose, order dependence included.

## Only the top frame is scanned (0.1.0)

**Decision.** The toolbar click injects into the clicked tab's top frame only. Images inside iframes are not compared.

**Why.** Every frame is an isolated script instance, so comparing across frames needs one collector per tab in the service worker, persisted because an MV3 service worker stops after about 30 seconds idle. Injecting into all frames also means running inside every advert and embed. Scanning each frame on its own would miss every cross-frame duplicate while appearing to cover iframes. The galleries and grids this is built for put their images in the top document.

## Runs only when the toolbar button is clicked (0.1.0)

**Decision.** No `content_scripts` in the manifest. The service worker injects `hash.js` and `content.js` with `chrome.scripting.executeScript` when the button is clicked; clicking again rescans.

**Why.** Nothing runs on pages the user did not ask about, there are no per-site match patterns to maintain, and all state lives in that tab's injected instance. Host access to `http(s)` is still needed so the service worker can fetch cross-origin images and read their pixels. Because a click can point it at any page, that fetch sends no cookies and is bounded in type, size and time.
