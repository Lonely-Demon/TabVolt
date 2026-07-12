---
name: verify
description: Verify TabVolt (MV3 Chrome extension) end-to-end by loading it unpacked in headless Chromium via Playwright, driving the popup/history pages, and asserting on service-worker state.
---

# Verifying TabVolt

TabVolt is an unpacked MV3 extension — no build step. The surface is the
extension loaded in a real Chromium: the popup UI, the history/analytics
page, and the service worker's published state in `chrome.storage.session`.

## Launch recipe (Playwright)

```js
const ctx = await chromium.launchPersistentContext(tmpProfileDir, {
  headless: true,
  channel: 'chromium',   // REQUIRED: default headless shell has no extension support
  args: [
    '--disable-extensions-except=/path/to/TabVolt',
    '--load-extension=/path/to/TabVolt',
  ],
});
let sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker');
const extId = new URL(sw.url()).host;
```

- Open a handful of local pages (serve tiny HTML with distinct `<title>`s on
  127.0.0.1 — no external network needed) so the tab table has content.
- Wait ~13s (2–3 poll cycles at the 5s plugged-in interval), then assert on
  `sw.evaluate(() => chrome.storage.session.get(null))`: `poll.cycle_count`
  advancing, `tabs[]`, `system.battery_pct` (100/charging in headless via the
  offscreen document), `heatmap_buffer` populated.
- Drive the popup at `chrome-extension://<id>/popup.html` as a normal page;
  history/analytics at `chrome-extension://<id>/history.html`.
- The IndexedDB flush cadence is 30s — wait that long before expecting
  analytics stat cards or the sessions list to be non-empty.

## Gotchas

- **`chrome.tabs.discard()` crashes headless Chromium under CDP** (whole
  browser exits). Do NOT click "Suspend idle" / trigger discards in the
  harness. Verify suspension up to the API boundary instead: candidate
  selection via storage state, and the protect-refusal path with
  `chrome.runtime.sendMessage({type:'SUSPEND_TAB', tabId})` on a protected
  tab (refuses before any discard).
- `chrome.offscreen.createDocument()` may never settle in this environment;
  the extension treats it fire-and-forget for this reason.
- The popup fetches `http://127.0.0.1:9001/metrics` (companion); when it's
  not running the console logs `ERR_CONNECTION_REFUSED` — expected noise.
- Playwright pages don't share one window's focus model the way real usage
  does; `tab.active` may be true for more tabs than you expect. Don't assert
  on exact suspend-candidate counts, assert on inclusion/exclusion.

## Flows worth driving

Search filter (+ garbage query → empty state), column sort (3-click cycle:
desc → asc → browser order), settings drawer (budget validation toast, real
budget → strip label, clear), AI suggest without key (graceful message,
Act-Now stays hidden), sleep + protect row actions (badges land on the next
poll cycle — wait ~6.5s), history page stat cards + sessions table.
