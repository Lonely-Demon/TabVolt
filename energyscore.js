// energyscore.js — Pure math functions only
// NO Chrome APIs. NO DOM. NO fetch. Ever.
// Imported by background.js (service worker) and popup.js (ES module).

/** Clamp a value into [0, 1]. */
function unit(x) {
  return Math.max(0, Math.min(1, x));
}

// Pages Chrome never allows extensions to inject scripts into, regardless of
// host_permissions — internal browser UI, the extension store, other
// extensions' pages, dev tooling. (about:blank is deliberately NOT in this
// list — it's a real scriptable document.)
const RESTRICTED_URL_PREFIXES = [
  'chrome://', 'chrome-extension://', 'edge://', 'chrome-search://',
  'chrome-untrusted://', 'devtools://', 'view-source:',
  'https://chrome.google.com/webstore', 'https://chromewebstore.google.com'
];

/**
 * True if a tab's URL is one Chrome will refuse `chrome.scripting`
 * injection on (or has no URL yet, e.g. still loading). Used to hide
 * script-dependent actions before the user ever hits the resulting error.
 */
export function isRestrictedUrl(url) {
  if (!url) return true;
  return RESTRICTED_URL_PREFIXES.some(p => url.startsWith(p));
}

// Saturation points: the input value at which each signal counts as "maxed".
const CPU_SATURATION_PCT = 50;   // a tab using 50% of system CPU is maxed
const NET_SATURATION_KB = 512;   // 512 KB transferred in one cycle is maxed
const IDLE_SATURATION_MINS = 30; // 30 minutes idle is maxed

/**
 * Compute weighted EnergyScore for a single tab, 0–100.
 *
 * Every input is normalized to [0,1] before weighting so that no single
 * unbounded term (idle minutes, network KB) can dominate the score — a tab
 * left idle overnight is *reclaimable*, not "high energy", and scores are
 * comparable across tabs.
 *
 * Weights: 0.55 CPU | 0.20 network | 0.15 idle | 0.10 background
 */
export function computeEnergyScore(cpu_pct, idle_mins, kb_per_cycle, is_background) {
  const cpuTerm = unit(cpu_pct / CPU_SATURATION_PCT);
  const netTerm = unit(kb_per_cycle / NET_SATURATION_KB);
  const idleTerm = unit(idle_mins / IDLE_SATURATION_MINS);
  const bgTerm = is_background ? 1 : 0;
  const raw = 100 * (0.55 * cpuTerm + 0.20 * netTerm + 0.15 * idleTerm + 0.10 * bgTerm);
  // Round to 2 decimals: kills float dust (100×0.55 = 55.000000000000006)
  // so equal inputs always produce the exact same score.
  return Math.max(0, Math.min(100, Math.round(raw * 100) / 100));
}

/**
 * @returns {"high"|"mid"|"low"}
 */
export function getScoreTier(score) {
  if (score >= 70) return 'high';
  if (score >= 30) return 'mid';
  return 'low';
}

/**
 * Map tier string to locked palette hex color.
 */
export function getTierColor(tier) {
  switch (tier) {
    case 'high': return '#C0392B';
    case 'mid': return '#F39C12';
    case 'low': return '#27AE60';
    default: return '#AAAAAA';
  }
}

/**
 * Estimate milliwatt-hours consumed by a tab over one poll cycle.
 * Formula: (cpu_pct/100) × tdp_watts × (elapsed_seconds/3600) × 1000
 * `elapsed_seconds` should be the *measured* time since the previous cycle,
 * not the nominal interval, so energy integrates correctly under timer drift.
 */
export function estimateMwh(cpu_pct, elapsed_seconds, tdp_watts = 15) {
  return (cpu_pct / 100) * tdp_watts * (elapsed_seconds / 3600) * 1000;
}

// Grid carbon intensity: India CEA weighted average, kg CO₂ per kWh.
export const GRID_KG_CO2_PER_KWH = 0.82;

/**
 * Convert mWh to grams CO₂ using the grid factor above.
 * 1 kWh = 1,000,000 mWh, and 0.82 kg/kWh = 820 g/kWh, so:
 *   grams = (mwh / 1e6) × 820 = mwh × 0.00082
 * (An earlier version divided by 1000 instead of 1e6 — treating Wh as
 * kWh — and overstated every CO₂ figure by 1000×.)
 */
export function estimateCO2g(mwh) {
  return (mwh / 1e6) * GRID_KG_CO2_PER_KWH * 1000;
}

/**
 * Format a CO₂ mass in grams with a sensible unit (mg / g / kg).
 * Pure string math — shared by popup, history, and analytics.
 */
export function formatCO2Mass(grams) {
  if (grams >= 1000) return (grams / 1000).toFixed(2) + ' kg';
  if (grams >= 1) return grams.toFixed(2) + ' g';
  return (grams * 1000).toFixed(1) + ' mg';
}

/**
 * Adaptive polling interval — 5 tiers, in milliseconds.
 *
 * `battery_pct` may be null when no battery reading is available yet
 * (e.g. desktop machines); treat that as plugged in.
 * Evaluation order: emergency first, then charging, then degrading tiers.
 * Longer intervals mean fewer service-worker wakeups — TabVolt itself
 * must not become the drain it measures.
 */
export function getAdaptiveInterval(battery_pct, cpu_pct, is_charging) {
  const hasBattery = battery_pct !== null && battery_pct !== undefined;
  if (hasBattery && !is_charging && battery_pct < 15) return 20000; // emergency
  if (!hasBattery || is_charging || battery_pct > 80) return 5000;  // plugged in
  if (cpu_pct > 70 || battery_pct < 30) return 15000;               // stressed
  if (cpu_pct >= 50 || battery_pct <= 50) return 10000;             // moderate
  return 8000;                                                      // on battery, healthy
}
