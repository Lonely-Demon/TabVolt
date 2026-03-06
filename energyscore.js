// energyscore.js — Pure math functions only
// NO Chrome APIs. NO DOM. NO fetch. Ever.
// Importable by background.js. Logic inlined separately in popup.js.

/**
 * Compute weighted EnergyScore for a single tab.
 * Formula: (0.50 × cpu) + (0.20 × idle) + (0.20 × kb) + (0.10 × bg)
 * Output clamped to 0–100.
 */
export function computeEnergyScore(cpu_pct, idle_mins, kb_per_min, is_background) {
  const raw = (0.50 * cpu_pct)
    + (0.20 * idle_mins)
    + (0.20 * kb_per_min)
    + (0.10 * (is_background ? 1 : 0));
  return Math.max(0, Math.min(100, raw));
}

/**
 * @returns {"high"|"mid"|"low"}
 */
export function getScoreTier(score) {
  if (score > 70) return 'high';
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
 * Estimate milliwatt-hours consumed by a tab in one poll cycle.
 * Formula: (cpu_pct/100) × tdp_watts × (poll_interval_seconds/3600) × 1000
 */
export function estimateMwh(cpu_pct, poll_interval_seconds, tdp_watts = 15) {
  return (cpu_pct / 100) * tdp_watts * (poll_interval_seconds / 3600) * 1000;
}

/**
 * Convert mWh to grams CO₂ using India CEA factor (0.82 kg/kWh).
 * Formula: (mwh / 1000) × 0.82 × 1000
 */
export function estimateCO2g(mwh) {
  return (mwh / 1000) * 0.82 * 1000;
}

/**
 * Adaptive polling interval — 5 tiers.
 * Returns interval in milliseconds.
 * Evaluation order: emergency first, then charging, then degrading tiers.
 */
export function getAdaptiveInterval(battery_pct, cpu_pct, is_charging) {
  if (battery_pct < 15) return 20000; // emergency
  if (is_charging || battery_pct > 80) return 3000;  // plugged in
  if (cpu_pct > 70 || battery_pct < 30) return 15000; // stressed
  if ((cpu_pct >= 50 && cpu_pct <= 70)
    || (battery_pct >= 30 && battery_pct <= 50)) return 10000; // moderate
  if (battery_pct > 50 && cpu_pct < 50) return 5000;  // normal
  return 5000; // default fallback
}
