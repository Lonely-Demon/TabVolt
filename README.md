# TabVolt ⚡🌍

**TabVolt** is a per-tab energy intelligence Chrome extension. It monitors, ranks, and visualizes the energy and carbon footprint of your browsing in real time — a task manager for tab energy — helping you reclaim system resources and reduce your environmental impact.

## ✨ Features

- **Per-tab energy scoring** — a normalized 0–100 Energy Score for every open tab, weighted across estimated CPU share (55%), network activity (20%), idle time (15%), and background state (10%).
- **Task-manager UI** — a sortable, searchable live table of every tab (CPU / network / score columns), updated in place with zero flicker, with per-row actions: suspend, pause animations, protect.
- **Real battery awareness** — battery level and charging state are read via an offscreen document (the Battery Status API isn't available to MV3 service workers) and drive:
  - **Adaptive polling** — 5 s when plugged in, degrading to 20 s on critical battery, so TabVolt never becomes the drain it measures.
  - **Energy Budget mode** — "keep my battery above 30% until 18:00"; TabVolt projects your drain rate and suspends the worst offenders when you're off track.
  - **Battery-critical protection** — automatic suspension of the top three drains below 15%.
- **Auto-suspend** — background tabs idle past a configurable threshold (off / 5 / 15 / 30 min) are discarded, Edge-Sleeping-Tabs style. Pinned, audible, and protected tabs are never touched.
- **Protect mode** — shield any tab or domain from every automatic and manual suspension path.
- **Pattern learning** — event-driven open/return counters per domain flag tabs you habitually abandon ("rarely revisited — safe to suspend").
- **AI suggestions (optional)** — Groq-hosted Llama explains which tab to suspend and why. The model only ever sees pre-filtered suspendable candidates and returns a numbered pick, so it cannot name a tab that isn't safe to act on — and "Act Now" suspends exactly the tab it named.
- **Analytics dashboard** — Grafana-style charts (power & CO₂ timelines, CPU by domain, worst offenders, savings) plus a tree-equivalency view, with time-range filtering backed by IndexedDB range queries.
- **Hardware companion (Windows, optional)** — a small Go server reads real CPU temperature and iGPU utilization from WMI and serves them to the popup on `127.0.0.1:9001`.

## 🚀 Setup

### 1. Install the extension

1. Open `chrome://extensions/` (Chrome 125+).
2. Enable **Developer mode**.
3. Click **Load unpacked** and select the repository root.

### 2. Optional: AI suggestions

1. Get a free API key at [console.groq.com/keys](https://console.groq.com/keys).
2. Open the TabVolt popup → gear icon → **AI suggestions** → paste the key → Save.
   The key is stored in `chrome.storage.local` on your machine and is only ever sent to Groq.

### 3. Optional: hardware companion (Windows)

The companion binary is **not** checked into the repo — build it once from source:

```
cd companion
go build -o tabvolt-companion.exe .
```

or just run `start_companion.bat`, which builds automatically if [Go](https://go.dev/dl/) is installed. Run it **as Administrator** if you want CPU temperature (the `MSAcpi_ThermalZoneTemperature` sensor requires elevation on most machines). Then enable **Enhanced mode** in the popup's settings drawer.

## 🛠️ Tech stack

- **Extension:** Manifest V3, vanilla ES modules, HTML5 Canvas (heatmap), Chart.js (analytics), IndexedDB.
- **Companion:** Go + `go-ole` for COM/WMI, single-threaded collector pinned with `runtime.LockOSThread`.
- **AI:** Groq (`llama-3.1-8b-instant`) via the OpenAI-compatible chat completions API.

## 📄 Architecture

| File | Role |
|---|---|
| `background.js` | Service worker. Self-scheduling adaptive poll loop (5–20 s), heuristic per-tab CPU attribution, in-memory hot state, 30 s aggregated IndexedDB flushes, suspension engine, budget engine, AI orchestration. |
| `offscreen.js` | Offscreen document that relays Battery Status API readings to the worker (event-driven + 60 s heartbeat). |
| `energyscore.js` | Pure scoring/estimation math. No Chrome APIs, no DOM — unit-testable. |
| `storage.js` | The single owner of the IndexedDB schema. Batched writes, timestamp-range reads, retention pruning for all stores. |
| `popup.js/.html/.css` | Task-manager UI. Differential DOM renderer keyed by tab id, sortable columns, search, settings drawer, canvas heatmap. |
| `analytics.js` / `history.js` | Dashboard + session history, reading through `storage.js` with range queries. |
| `companion/main.go` | Loopback-only metrics server; WMI polled on a cached background loop, CORS restricted to extension origins. |

### Performance notes

- One `chrome.storage.session` write per poll cycle; IndexedDB is touched every 30 s with one aggregated record per tab (~10× fewer rows than per-cycle writes).
- Every store has a retention window (7 d cycles, 30 d events/sessions/patterns) enforced at startup.
- The popup re-renders only when the worker publishes a new sample, and only mutates DOM nodes whose values changed.

### Privacy

All monitoring data (tab titles, URLs, per-tab metrics) stays in your browser's IndexedDB and is pruned automatically. Nothing leaves your machine unless you enable AI suggestions, in which case the titles of suspendable background tabs are sent to Groq with your own API key.

## 🤝 Contribution

Created for environmental awareness and better browsing performance. Pull requests and feedback are welcome!
