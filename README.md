# TabVolt ⚡🌍

**TabVolt** is a per-tab energy intelligence Chrome extension. It monitors, ranks, and visualizes the energy and carbon footprint of your browsing habits in real-time, helping you reclaim system resources and reduce your environmental impact.

![Phase 2 Analytics Dashboard](.gemini/antigravity/brain/9739d04b-22dc-42a2-b87a-0534966b1de8/media__1772730932424.png) *(Note: Add your own screenshot here)*

## ✨ Features

- **Per-Tab Energy Scoring:** Calculates a real-time "Energy Score" (1-100) for every open tab using heuristics based on CPU share, network activity, audio playing, and background idle time.
- **Hardware Integration (Windows Only):** A native Go companion server that reads real CPU temperatures and iGPU utilization directly from Windows Management Instrumentation (WMI).
- **AI-Powered Optimization:** Integrates with local/cloud LLMs (via OpenRouter) to provide intelligent explanations for high energy usage and actionable optimization suggestions.
- **Auto-Suspend "Sleeping Tabs":** Automatically discards background tabs that have been idle for >5 minutes to free up RAM and reduce CPU load.
- **Analytics Dashboard:** A beautiful, Grafana-style dashboard with time-range filtering, showing:
  - Power Usage & CO₂ Footprint timelines
  - Resource Distribution & Worst Offenders charts
  - Power / CO₂ Savings over time
  - **Tree Equivalency Visualization:** Translates raw CO₂ grams saved/emitted into equivalent tree carbon absorption.

## 🚀 Setup Instructions

### 1. Install the Chrome Extension

1. Open Chrome and navigate to `chrome://extensions/`.
2. Enable **Developer mode** (toggle in the top right corner).
3. Click **Load unpacked**.
4. Select the root `TabVolt` repository directory.

### 2. Run the Hardware Companion (Optional for Advanced Metrics)

To enable real hardware monitoring (CPU Temperature, iGPU usage), you need to run the companion server.

1. Navigate to the `companion/` directory inside the project.
2. Double-click the `start_companion.bat` file.
   - *Note: For Windows to expose the `MSAcpi_ThermalZoneTemperature` sensor, you must run the batch file as **Administrator**.*
3. A terminal window will open, indicating the companion server is running on port `:9001`.
4. Open the TabVolt extension popup in Chrome and toggle **Enhanced Mode** to connect to the companion.

## 🛠️ Tech Stack

- **Frontend / Extension:** HTML5 Canvas (Heatmaps), Vanilla CSS, JavaScript (ES6 Modules), Chart.js (Analytics), Chrome Extensions API (Manifest V3).
- **Backend / Companion:** Go (Golang), `go-ole` for Windows COM threading, WMI (Windows Management Instrumentation).
- **Storage:** IndexedDB (for persisting historical tab cycles and suspend events).
- **AI:** OpenRouter API (`arcee-ai/trinity-large-preview` or equivalent).

## 📄 Architecture Overview

- **`background.js`**: The highly optimized service worker running the 30-second poll cycle engine, computing heuristic energy scores, and logging metrics to the database.
- **`popup.js` / `popup.html`**: The real-time user interface, featuring dynamic state lists and sorting, plus a real-time visual canvas heatmap of tab activity.
- **`history.js` / `analytics.js`**: The dashboard controllers powering the historical charts and session lists.
- **`companion/main.go`**: A heavily-threaded Go server that locks OS threads to execute COM WMI queries safely.

## 🤝 Contribution

Created for environmental awareness and better browsing performance. Pull requests and feedback are welcome!
