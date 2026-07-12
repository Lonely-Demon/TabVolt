// Unit tests for the pure scoring/estimation module.
// Run with: npm test  (node --test tests/)
//
// These lock in the physical units — the CO₂ conversion shipped with a
// 1000× unit error (Wh treated as kWh) for two release phases because
// nothing asserted a known-good value.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    computeEnergyScore, getScoreTier, getTierColor,
    estimateMwh, estimateCO2g, formatCO2Mass,
    getAdaptiveInterval, GRID_KG_CO2_PER_KWH
} from '../energyscore.js';

// ---------------------------------------------------------------------------
// computeEnergyScore — normalized weighting, clamped 0–100
// ---------------------------------------------------------------------------

test('score is 0 for a fully idle active tab', () => {
    assert.equal(computeEnergyScore(0, 0, 0, false), 0);
});

test('CPU term saturates at 50% and carries 55 points', () => {
    assert.equal(computeEnergyScore(50, 0, 0, false), 55);
    assert.equal(computeEnergyScore(100, 0, 0, false), 55); // clamped, not 110
});

test('a long-idle background tab cannot reach the "high" tier on idle alone', () => {
    // idle (15) + background (10) = 25 — reclaimable, but not "hot".
    const score = computeEnergyScore(0, 10000, 0, true);
    assert.equal(score, 25);
    assert.equal(getScoreTier(score), 'low');
});

test('non-CPU terms max out at 45 points combined', () => {
    assert.equal(computeEnergyScore(0, 1e9, 1e9, true), 45);
});

test('all terms maxed yields exactly 100', () => {
    assert.equal(computeEnergyScore(50, 30, 512, true), 100);
});

test('half-saturated inputs scale linearly', () => {
    // 25% cpu (half of 50) → 27.5, 256 KB (half of 512) → 10, active tab.
    assert.equal(computeEnergyScore(25, 0, 256, false), 37.5);
});

// ---------------------------------------------------------------------------
// Tiers + colors
// ---------------------------------------------------------------------------

test('tier boundaries: 70 is high, 30 is mid, below 30 is low', () => {
    assert.equal(getScoreTier(70), 'high');
    assert.equal(getScoreTier(69.9), 'mid');
    assert.equal(getScoreTier(30), 'mid');
    assert.equal(getScoreTier(29.9), 'low');
    assert.equal(getScoreTier(0), 'low');
});

test('tier colors map to the locked palette', () => {
    assert.equal(getTierColor('high'), '#C0392B');
    assert.equal(getTierColor('mid'), '#F39C12');
    assert.equal(getTierColor('low'), '#27AE60');
    assert.equal(getTierColor('nonsense'), '#AAAAAA');
});

// ---------------------------------------------------------------------------
// Energy + CO₂ physics
// ---------------------------------------------------------------------------

test('estimateMwh: 100% CPU for one hour at 15W is 15 Wh (15000 mWh)', () => {
    assert.equal(estimateMwh(100, 3600), 15000);
});

test('estimateMwh: scales with cpu share, duration, and TDP', () => {
    // 50% of a 10W budget for one minute: 0.5 × 10 × (60/3600) × 1000
    assert.ok(Math.abs(estimateMwh(50, 60, 10) - 83.3333) < 0.001);
});

test('estimateCO2g: 1 kWh (1e6 mWh) emits 820 g at the 0.82 kg/kWh grid factor', () => {
    assert.equal(GRID_KG_CO2_PER_KWH, 0.82);
    assert.equal(estimateCO2g(1_000_000), 820);
});

test('estimateCO2g: 1 Wh emits 0.82 g — NOT 820 g (the historical 1000× bug)', () => {
    assert.ok(Math.abs(estimateCO2g(1000) - 0.82) < 1e-9);
});

test('formatCO2Mass picks sensible units', () => {
    assert.equal(formatCO2Mass(0.0043), '4.3 mg');
    assert.equal(formatCO2Mass(2.5), '2.50 g');
    assert.equal(formatCO2Mass(1500), '1.50 kg');
});

// ---------------------------------------------------------------------------
// Adaptive polling
// ---------------------------------------------------------------------------

test('emergency tier: <15% battery and discharging polls every 20s', () => {
    assert.equal(getAdaptiveInterval(10, 0, false), 20000);
});

test('charging or high battery polls at the fastest 5s tier', () => {
    assert.equal(getAdaptiveInterval(50, 0, true), 5000);
    assert.equal(getAdaptiveInterval(90, 0, false), 5000);
});

test('no battery reading (desktop) is treated as plugged in', () => {
    assert.equal(getAdaptiveInterval(null, 0, false), 5000);
    assert.equal(getAdaptiveInterval(undefined, 99, false), 5000);
});

test('stressed tier: high CPU or low battery backs off to 15s', () => {
    assert.equal(getAdaptiveInterval(60, 80, false), 15000);
    assert.equal(getAdaptiveInterval(25, 0, false), 15000);
});

test('moderate and healthy tiers', () => {
    assert.equal(getAdaptiveInterval(45, 10, false), 10000); // battery ≤ 50
    assert.equal(getAdaptiveInterval(60, 55, false), 10000); // cpu ≥ 50
    assert.equal(getAdaptiveInterval(60, 10, false), 8000);  // healthy on battery
});

test('charging never triggers the emergency tier', () => {
    assert.equal(getAdaptiveInterval(10, 0, true), 5000);
});
