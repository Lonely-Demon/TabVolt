# TabVolt — Phase 2 Briefing Document

This document summarizes all the features, architectural enhancements, and fixes implemented during **Phase 2** of the TabVolt project. Phase 2 focused on deep hardware integration, visual analytics, and automated power saving.

---

## 1. Hardware Integration (Go Companion Server)

To bypass browser limitations and read actual hardware sensors, we built a native Windows companion app.

* **WMI Sensor Server**: A lightweight Go server (`companion/main.go`) running on `:9001` that queries Windows Management Instrumentation (WMI).
* **Metrics Captured**: Real-time CPU Temperature (via `MSAcpi_ThermalZoneTemperature`) and iGPU Utilization (via `Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine`).
* **Robust Threading**: Integrated `runtime.LockOSThread()` to ensure COM object stability during WMI polling.
* **Easy Launcher**: Created `companion/start_companion.bat` for one-click startup requiring no technical knowledge.

## 2. Popup UI & Heatmap Rendering

The main extension popup was upgraded to provide deeper, immediate insights.

* **Enhanced Mode Toggle**: A responsive UI switch that connects to the Go companion. If the companion is offline, it gracefully displays setup instructions and the `.bat` file path.
* **Companion Panel**: Displays the live hardware temperature and iGPU usage when connected.
* **Activity Heatmap**: A custom HTML5 Canvas implementation (`renderHeatmap()`) that visualizes the last 5 minutes of browser activity.
  * HiDPI canvas scaling (`devicePixelRatio`) for crisp rendering on modern displays.
  * Real tab favicons fetched securely via the `chrome.runtime.getURL('_favicon/')` API.
* **CSP Fixes**: Removed conflicting legacy libraries (like old Chart.js UMD wrappers) that triggered Manifest V3 Content Security Policy errors in the popup.

## 3. Analytics Dashboard & Session History

The history page was completely rebuilt from a simple table into a comprehensive, Grafana-style analytics dashboard.

* **Tabbed Navigation**: split into **Analytics** (visual insights) and **Sessions** (raw data tables).
* **Time Range Filtering**: Cross-session filtering across Today, 7 Days, 30 Days, or All Time.
* **Stat Cards**: 6 key metrics tracking Total Power Used (mWh), CO₂ Emitted (g), Power Saved, CO₂ Saved, Peak CPU, and Tabs Monitored.
* **6 Chart.js Visualizations**:
  1. Power Usage Timeline (Area)
  2. CO₂ Footprint Timeline (Area)
  3. CPU Usage Over Time (Stacked area by top 5 domains)
  4. Resource Distribution (Donut chart)
  5. Worst Offenders (Horizontal bar)
  6. Savings Over Time (Bar chart tracking suspended tab savings)
* **Tree Equivalency Visualization**: A redesigned, intuitive section using SVG icons that translates raw CO₂ grams into "trees' worth of daily carbon absorption" (baseline: 59.6g CO₂/day per tree).

## 4. Background Engine & Storage Upgrades

The core background worker and database were upgraded to support the new analytics and automation.

* **IndexedDB v2 Migration**: Safely upgraded the database schema to version 2, adding a dedicated `suspend_events` store to track when tabs are put to sleep.
* **Accurate Session Aggregation**: Shifted session grouping from `domain||title` to `tab_id`. This correctly groups long-running tabs with highly dynamic titles (like Spotify or YouTube playing consecutive songs).
* **Auto-Suspend Automation**: Implemented a background chronological check similar to Microsoft Edge's "Sleeping Tabs".
  * Any background tab idle for **>5 minutes** (that isn't playing audio or pinned) is automatically discarded from memory.
* **Savings Tracking Engine**: Every time a tab is suspended (via Auto-Suspend, the Manual Button, Bulk Optimization, or AI Suggestion), its metrics at that exact moment (CPU%, energy score, mWh rate) are logged to calculate exactly how much energy and carbon was saved while it slept.
