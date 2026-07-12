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
    getAdaptiveInterval, GRID_KG_CO2_PER_KWH, isRestrictedUrl,
    computeCpuWeight, computeMemoryWeight, BROWSER_MEM_SHARE_ASSUMPTION
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

// ---------------------------------------------------------------------------
// Restricted-page detection — the set of pages Chrome refuses script
// injection into regardless of host_permissions.
// ---------------------------------------------------------------------------

test('ordinary https/http pages are not restricted', () => {
    assert.equal(isRestrictedUrl('https://example.com/page'), false);
    assert.equal(isRestrictedUrl('http://localhost:3000'), false);
});

test('about:blank is scriptable — not restricted', () => {
    assert.equal(isRestrictedUrl('about:blank'), false);
});

test('internal browser and store pages are restricted', () => {
    assert.equal(isRestrictedUrl('chrome://settings'), true);
    assert.equal(isRestrictedUrl('chrome://extensions/'), true);
    assert.equal(isRestrictedUrl('edge://settings'), true);
    assert.equal(isRestrictedUrl('devtools://devtools/bundled/inspector.html'), true);
    assert.equal(isRestrictedUrl('view-source:https://example.com'), true);
    assert.equal(isRestrictedUrl('https://chromewebstore.google.com/detail/x'), true);
    assert.equal(isRestrictedUrl('chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/x.html'), true);
});

test('no URL yet (tab still loading) counts as restricted', () => {
    assert.equal(isRestrictedUrl(''), true);
    assert.equal(isRestrictedUrl(undefined), true);
});

// ---------------------------------------------------------------------------
// computeMemoryWeight — deliberately different signals than the CPU weight,
// so the RAM column isn't just a rescaled copy of the CPU column.
// ---------------------------------------------------------------------------

test('a silent, idle, non-loading tab gets only the baseline memory weight', () => {
    assert.equal(computeMemoryWeight(false, false, 0, false), 1);
});

test('idle time is not a memory-weight input (unlike the CPU weight)', () => {
    // computeMemoryWeight has no idle_mins parameter at all — a tab that's
    // sat idle for hours still holds its DOM/JS heap, so nothing here should
    // decay with time the way the CPU-derived energy score does.
    assert.equal(computeMemoryWeight.length, 4);
});

test('audible tabs get the media-buffer bonus', () => {
    assert.equal(computeMemoryWeight(true, false, 0, false), 1 + 15);
});

test('loading tabs get the in-flight-assets bonus', () => {
    assert.equal(computeMemoryWeight(false, true, 0, false), 1 + 10);
});

test('active tab gets a small bonus, much smaller than audible/loading', () => {
    assert.equal(computeMemoryWeight(false, false, 0, true), 1 + 1);
});

test('network KB scales the weight up to a cap', () => {
    assert.equal(computeMemoryWeight(false, false, 40, false), 1 + 10); // 40/4 = 10, under cap
    assert.equal(computeMemoryWeight(false, false, 1000, false), 1 + 25); // capped at 25
});

test('all signals combine additively', () => {
    assert.equal(computeMemoryWeight(true, true, 40, true), 1 + 15 + 10 + 10 + 1);
});

// ---------------------------------------------------------------------------
// computeCpuWeight
// ---------------------------------------------------------------------------

test('a silent, non-loading, background tab gets only the baseline CPU weight', () => {
    assert.equal(computeCpuWeight(false, false, false, 0), 1);
});

test('audible/loading/network reflect real activity and outweigh mere focus', () => {
    assert.equal(computeCpuWeight(false, true, false, 0), 1 + 20);  // audible
    assert.equal(computeCpuWeight(false, false, true, 0), 1 + 15);  // loading
    assert.equal(computeCpuWeight(false, false, false, 25), 1 + 5); // 25/5=5
    assert.equal(computeCpuWeight(true, false, false, 0), 1 + 1);  // merely active — literally double baseline
});

test('network KB scales up to a cap', () => {
    assert.equal(computeCpuWeight(false, false, false, 1000), 1 + 15); // capped
});

// Regression for the exact complaint this was built to fix: a completely
// idle, static, merely-focused tab previously claimed 88.5% of an all-static
// 4-tab set's total CPU weight (with the old +30 active bonus) while doing
// nothing — verified empirically in a live Chromium instance. With the +1
// active bonus, the same 4-tab scenario lands at exactly 40% (double a
// background tab's weight, not 31x it) — comfortably under half, reproduced
// here as a permanent unit test so this specific bug can't silently return.
test('a merely-focused static tab does not dominate a small handful of tabs', () => {
    const active = computeCpuWeight(true, false, false, 0);
    const background = computeCpuWeight(false, false, false, 0);
    const total = active + background * 3;
    const activeShare = (active / total) * 100;
    assert.ok(activeShare < 45, `active share ${activeShare}% should not dominate`);
});

test('the same domination check holds for the memory weight', () => {
    const active = computeMemoryWeight(false, false, 0, true);
    const background = computeMemoryWeight(false, false, 0, false);
    const total = active + background * 3;
    const activeShare = (active / total) * 100;
    assert.ok(activeShare < 45, `active share ${activeShare}% should not dominate`);
});

test('the assumed browser share of system memory is a fraction under one', () => {
    assert.ok(BROWSER_MEM_SHARE_ASSUMPTION > 0 && BROWSER_MEM_SHARE_ASSUMPTION < 1);
});
