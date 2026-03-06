# TabVolt — Phase 1 Post-Launch Iteration & Refinement Log

## 1. Executive Summary

This document chronicles the technical challenges, architectural pivots, and UI/UX refinements implemented immediately following the initial Phase 1 build. The core focus across these iterations was achieving stability on the Chrome Stable channel, eliminating AI hallucination, stabilizing the Service Worker lifecycle, and refining the energy intelligence UI.

## 2. Core Architectural & API Updates

### 2.1 The `processes` Permission Pivot

* **Initial State**: The extension relied on `chrome.processes` to retrieve exact per-tab CPU and RAM metrics.
* **The Problem**: Discovered that `chrome.processes` is restricted to the Chrome Dev and Canary channels. Including it in the manifest throws an installation error on standard Chrome Stable builds.
* **The Solution**:
  * Completely removed `processes` from `manifest.json`.
  * Implemented a **Heuristic CPU/RAM Estimation Engine** in the Service Worker.
  * Uses `chrome.system.cpu` and `chrome.system.memory` to calculate system-wide deltas.
  * Distributes a 60% system CPU baseline across open tabs using weighted scoring: active (+30), audible (+20), loading (+15), and network I/O (`chrome.webRequest.onCompleted` bytes transferred).

### 2.2 Service Worker Lifecycle & TDZ (Temporal Dead Zone) Fixes

* **The Problem**: Frequent "Error: No SW" messages when injecting scripts, and a Temporal Dead Zone crash (`Cannot access '_initialized' before initialization`) that broke the entire polling loop.
* **The Solution**:
    1. **Strict Hoisting**: Moved all module-level state variables and constants to the absolute top of `background.js` before any function calls or event listeners.
    2. **Lifecycle Handlers**: Implemented rigorous SW lifecycle management (`self.addEventListener('install', () => self.skipWaiting())`, `clients.claim()`).
    3. **Boot Sequence**: `startPolling()` now runs immediately without waiting for the first alarm tick, ensuring the UI populates instantly.

### 2.3 Contextual Suspend (Act Now) vs. Sleep

* **Initial State**: The "Suspend" feature discarded tabs, but the AI's "Act Now" logic sent a generic `SUSPEND_TOP_N` command which sometimes targeted active, pinned, or audible tabs. Sleep state wasn't guarded against already suspended tabs, causing script injection crashes.
* **The Solution**:
  * **State Separation**:
    * *Suspended*: Tab discarded from memory completely via `chrome.tabs.discard`.
    * *Sleeping*: DOM animations paused via injected CSS (`animation-play-state: paused`) and `requestAnimationFrame` hijacked to return 0.
  * **Act Now Targeting**: Rewired to use a new `SUSPEND_SPECIFIC` message, explicitly targeting the highest energy-consuming, non-audible, non-active background tab.

## 3. AI Suggestions & Prompt Engineering

### 3.1 Eliminating "Blind" Hallucinations

* **The Problem**: The AI would confidently suggest closing non-existent tabs, or worse, suggest closing the actively used tab (e.g., Spotify or the current working tab). Successive API calls resulted in erratic formatting.
* **The Solution**: *Structural exclusion over rule-based prompting.*
    1. **Data Sanitization**: Active tabs, Pinned tabs, and Audible tabs are completely filtered out of the `candidateList` *before* the prompt is constructed. The AI physically cannot hallucinate them as candidates.
    2. **Grounding context**: Passed exact title strings, CPU, and idle time verbatim.
    3. **Deterministic Fallback**: If the candidate list is empty, a local, deterministic string ("Only active or audio-playing tabs remain. No action needed.") is returned without burning an API call.
    4. **Parameter Controls**: Lowered AI temperature to `0.2` to enforce strict formatting, brevity, and logic.
    5. **Dynamic UI**: Tied the "Act Now" button visibility exclusively to the existence of valid candidates (hidden when the fallback string is deployed).

## 4. UI / UX Refinements

### 4.1 The Portal Tooltip (Cross-row Context Panel)

* **The Problem**: Inline tab details clipped under other elements. Using `:hover` logic caused severe CSS-flicking and sudden disappearance of information if the mouse moved slightly over 1px gaps. The panel spanned the full width and felt cluttered.
* **The Solution**:
  * Stripped the inline detail rows out of the tab elements entirely.
  * Implemented a **Fixed-Position Portal Tooltip**: A single shared DOM element anchored to the bottom-right of the popup, styled like a clean onboarding card (`min-width: 170px`).
  * **Debounced Interaction**: JavaScript-controlled display requires 600ms of sustained hover to appear, with an 80ms grace period on mouseout to prevent flashing when moving between rows.
  * **Crisp Messaging**: Labeling explicitly states: *"Stats are relative to browser"* so users understand they aren't looking at absolute system values (preventing panic that a single tab is using 50% of machine RAM).

### 4.2 Professional Vector Iconography

* **The Problem**: Native emoji buttons (💤, ⏻) looked unprofessional, rendered inconsistently across OS text renderers, and scaled poorly.
* **The Solution**: Replaced all emoji buttons with inline, clean SVG paths: Crescent moon (Sleep), Pause bars (Suspend), Play triangle (Wake), Speaker (Audio protection).

### 4.3 Tab States & Visual Hierarchy

* **Audio Protection**: Audible tabs now render with a green speaker badge and cannot be suspended via mass-suspend buttons.
* **Visual States**:
  * *Suspended rows* (discarded): Opacity drops to 35% with a distinct strikethrough.
  * *Sleeping rows* (DOM frozen): Opacity drops to 70% with a purple badge state.
  * Action buttons dynamically swap depending on the current state (e.g., swapping Sleep/Suspend for a single Wake button).
