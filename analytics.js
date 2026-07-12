// analytics.js — Grafana-style analytics dashboard (ES module)
// Reads from IndexedDB via the shared storage.js layer — time-filtered views
// use the timestamp index instead of loading whole stores into memory.
// Renders Chart.js charts + stat cards + tree equivalency.

import { initDB, getAllRecords, getRecordsSince } from './storage.js';
import { formatCO2Mass } from './energyscore.js';

// Tree CO2 absorption constant: one mature tree absorbs ~21,770 g CO2/year
const TREE_CO2_PER_DAY_G = 21770 / 365; // ~59.6 g/day

// Legacy suspend events (pre-2.0) stored a per-cycle rate measured at 30s
// cycles; convert with that era's constant. New events carry mwh_per_hour.
const LEGACY_CYCLES_PER_HOUR = 120;

// Assumed suspension benefit window when a tab never reappears in the data.
const DEFAULT_SAVINGS_HOURS = 0.5;
const MAX_SAVINGS_HOURS = 1;

// Chart instances (for cleanup on re-render)
let chartInstances = {};
let analyticsDB = null;
let analyticsRange = 'today';

// ============================================================================
// TIME FILTERING
// ============================================================================

function getRangeCutoff() {
    const now = Date.now();
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    switch (analyticsRange) {
        case 'today': return startOfToday.getTime();
        case '7d': return now - 7 * 24 * 60 * 60 * 1000;
        case '30d': return now - 30 * 24 * 60 * 60 * 1000;
        default: return 0;
    }
}

// ============================================================================
// CHART.JS DEFAULTS
// ============================================================================

function setupChartDefaults() {
    Chart.defaults.color = '#AAAAAA';
    Chart.defaults.borderColor = 'rgba(255,255,255,0.05)';
    Chart.defaults.font.family = "-apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', Roboto, sans-serif";
    Chart.defaults.font.size = 11;
    Chart.defaults.plugins.legend.display = false;
    Chart.defaults.animation.duration = 600;
    Chart.defaults.elements.point.radius = 0;
    Chart.defaults.elements.point.hoverRadius = 4;
}

// ============================================================================
// SAVINGS MODEL — one estimator shared by every chart and stat card
// ============================================================================

/** mWh/hour this tab was drawing when it was suspended. */
function eventHourlyRate(evt) {
    if (evt.mwh_per_hour != null) return evt.mwh_per_hour;
    return (evt.pre_suspend_mwh_rate || 0) * LEGACY_CYCLES_PER_HOUR;
}

/**
 * Estimated mWh saved by one suspend event: rate × time-suspended, where
 * time-suspended runs until the tab reappears in the cycle data (capped),
 * or a conservative default when it never does.
 */
function estimateEventSavings(evt, cyclesByTab) {
    const later = cyclesByTab.get(evt.tab_id);
    let durationHrs = DEFAULT_SAVINGS_HOURS;
    if (later) {
        // cyclesByTab lists timestamps sorted ascending; find first after evt.
        const reappear = later.find(ts => ts > evt.timestamp);
        if (reappear) {
            durationHrs = Math.min((reappear - evt.timestamp) / 3600000, MAX_SAVINGS_HOURS);
        }
    }
    return eventHourlyRate(evt) * durationHrs;
}

/** Index cycle timestamps by tab_id once, so savings math is O(n + m). */
function indexCyclesByTab(cycles) {
    const byTab = new Map();
    for (const c of cycles) {
        if (c.tab_id == null) continue;
        let arr = byTab.get(c.tab_id);
        if (!arr) { arr = []; byTab.set(c.tab_id, arr); }
        arr.push(c.timestamp || 0);
    }
    for (const arr of byTab.values()) arr.sort((a, b) => a - b);
    return byTab;
}

// ============================================================================
// STAT CARDS
// ============================================================================

function renderStatCards(cycles, suspendEvents, sessions) {
    const totalMwh = cycles.reduce((s, c) => s + (c.mwh_estimated || 0), 0);
    const totalCO2 = cycles.reduce((s, c) => s + (c.co2_grams || 0), 0);

    const cyclesByTab = indexCyclesByTab(cycles);
    const savedMwh = suspendEvents.reduce((s, e) => s + estimateEventSavings(e, cyclesByTab), 0);
    const CO2_PER_MWH = totalMwh > 0 ? totalCO2 / totalMwh : 0.82;
    const savedCO2 = savedMwh * CO2_PER_MWH;

    // Peak CPU: max sum of all tab CPU% in a single flush window
    const cpuByTime = {};
    for (const c of cycles) {
        const t = c.timestamp || 0;
        cpuByTime[t] = (cpuByTime[t] || 0) + (c.cpu_pct || 0);
    }
    const peakCPU = Object.values(cpuByTime).length > 0
        ? Math.max(...Object.values(cpuByTime)) : 0;

    const tabIds = new Set(cycles.map(c => c.tab_id).filter(Boolean));
    const tabCount = tabIds.size || sessions.reduce((m, s) => Math.max(m, s.total_tabs_monitored || 0), 0);

    setText('stat-power-val', totalMwh.toFixed(1));
    setText('stat-co2-val', formatGrams(totalCO2));
    setText('stat-power-saved-val', savedMwh.toFixed(1));
    setText('stat-co2-saved-val', formatGrams(savedCO2));
    setText('stat-peak-cpu-val', peakCPU.toFixed(1));
    setText('stat-tabs-val', tabCount);

    return { totalMwh, totalCO2, savedMwh, savedCO2 };
}

// ============================================================================
// CHARTS
// ============================================================================

function renderPowerTimeline(cycles) {
    const data = aggregateTimeline(cycles, 'mwh_estimated');
    destroyChart('chart-power');

    const ctx = document.getElementById('chart-power').getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 0, 220);
    gradient.addColorStop(0, 'rgba(255, 107, 53, 0.4)');
    gradient.addColorStop(1, 'rgba(255, 107, 53, 0.02)');

    chartInstances['chart-power'] = new Chart(ctx, {
        type: 'line',
        data: {
            labels: data.labels,
            datasets: [{
                label: 'Power (mWh)',
                data: data.values,
                borderColor: '#FF6B35',
                backgroundColor: gradient,
                borderWidth: 2,
                fill: true,
                tension: 0.3
            }]
        },
        options: timelineOptions('mWh')
    });
}

function renderCO2Timeline(cycles) {
    const data = aggregateTimeline(cycles, 'co2_grams');
    // Grams per bucket are tiny — chart in milligrams for readable axes.
    data.values = data.values.map(v => Math.round(v * 1000 * 1000) / 1000);
    destroyChart('chart-co2');

    const ctx = document.getElementById('chart-co2').getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 0, 220);
    gradient.addColorStop(0, 'rgba(39, 174, 96, 0.4)');
    gradient.addColorStop(1, 'rgba(39, 174, 96, 0.02)');

    chartInstances['chart-co2'] = new Chart(ctx, {
        type: 'line',
        data: {
            labels: data.labels,
            datasets: [{
                label: 'CO₂ (mg)',
                data: data.values,
                borderColor: '#27AE60',
                backgroundColor: gradient,
                borderWidth: 2,
                fill: true,
                tension: 0.3
            }]
        },
        options: timelineOptions('mg')
    });
}

function renderCPUTimeline(cycles) {
    // Group by top 5 domains + "Other"
    const domainTotals = {};
    for (const c of cycles) {
        domainTotals[c.domain] = (domainTotals[c.domain] || 0) + (c.cpu_pct || 0);
    }
    const sortedDomains = Object.entries(domainTotals).sort((a, b) => b[1] - a[1]);
    const topDomains = sortedDomains.slice(0, 5).map(d => d[0]);

    const buckets = createTimeBuckets(cycles);
    const domainColors = ['#3498DB', '#E74C3C', '#F39C12', '#9B59B6', '#1ABC9C', '#95A5A6'];

    const avgCpuFor = (bucket, match) => {
        const rows = bucket.filter(match);
        if (rows.length === 0) return 0;
        return rows.reduce((s, c) => s + (c.cpu_pct || 0), 0) / rows.length;
    };

    const datasets = topDomains.map((domain, i) => ({
        label: domain || '(unknown)',
        data: buckets.bucketCycles.map(b => avgCpuFor(b, c => c.domain === domain)),
        borderColor: domainColors[i],
        backgroundColor: domainColors[i] + '40',
        borderWidth: 1.5,
        fill: true,
        tension: 0.3
    }));

    const otherValues = buckets.bucketCycles.map(b => avgCpuFor(b, c => !topDomains.includes(c.domain)));
    if (otherValues.some(v => v > 0)) {
        datasets.push({
            label: 'Other', data: otherValues,
            borderColor: '#95A5A6', backgroundColor: '#95A5A640',
            borderWidth: 1.5, fill: true, tension: 0.3
        });
    }

    destroyChart('chart-cpu');
    chartInstances['chart-cpu'] = new Chart(document.getElementById('chart-cpu').getContext('2d'), {
        type: 'line',
        data: { labels: buckets.labels, datasets },
        options: {
            ...timelineOptions('%'),
            plugins: {
                legend: { display: true, position: 'bottom', labels: { boxWidth: 10, font: { size: 10 } } }
            },
            scales: {
                x: { ticks: { maxTicksLimit: 10, color: '#666' }, grid: { color: 'rgba(255,255,255,0.03)' } },
                y: { stacked: true, ticks: { color: '#666', callback: v => v.toFixed(0) + '%' }, grid: { color: 'rgba(255,255,255,0.03)' } }
            }
        }
    });
}

function renderDomainDonut(cycles) {
    const domainMwh = {};
    for (const c of cycles) {
        const d = c.domain || '(unknown)';
        domainMwh[d] = (domainMwh[d] || 0) + (c.mwh_estimated || 0);
    }
    const sorted = Object.entries(domainMwh).sort((a, b) => b[1] - a[1]);
    const top6 = sorted.slice(0, 6);
    const otherMwh = sorted.slice(6).reduce((s, e) => s + e[1], 0);

    const labels = top6.map(e => e[0]);
    const values = top6.map(e => Math.round(e[1] * 1000) / 1000);
    if (otherMwh > 0) { labels.push('Other'); values.push(Math.round(otherMwh * 1000) / 1000); }

    const colors = ['#FF6B35', '#3498DB', '#E74C3C', '#F39C12', '#9B59B6', '#1ABC9C', '#95A5A6'];

    destroyChart('chart-domain');
    chartInstances['chart-domain'] = new Chart(document.getElementById('chart-domain').getContext('2d'), {
        type: 'doughnut',
        data: {
            labels,
            datasets: [{ data: values, backgroundColor: colors.slice(0, values.length), borderColor: '#16162A', borderWidth: 2 }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            cutout: '55%',
            plugins: {
                legend: { display: true, position: 'right', labels: { boxWidth: 10, font: { size: 10 }, color: '#AAA', padding: 8 } },
                tooltip: {
                    callbacks: {
                        label: (ctx) => `${ctx.label}: ${ctx.parsed.toFixed(3)} mWh`
                    }
                }
            }
        }
    });
}

function renderWorstOffenders(cycles) {
    const domainStats = {};
    for (const c of cycles) {
        const d = c.domain || '(unknown)';
        if (!domainStats[d]) domainStats[d] = { mwh: 0, cpuSum: 0, count: 0 };
        domainStats[d].mwh += c.mwh_estimated || 0;
        domainStats[d].cpuSum += c.cpu_pct || 0;
        domainStats[d].count++;
    }

    const sorted = Object.entries(domainStats)
        .map(([domain, s]) => ({ domain, mwh: s.mwh, avgCpu: s.cpuSum / s.count }))
        .sort((a, b) => b.mwh - a.mwh)
        .slice(0, 5);

    destroyChart('chart-offenders');
    chartInstances['chart-offenders'] = new Chart(document.getElementById('chart-offenders').getContext('2d'), {
        type: 'bar',
        data: {
            labels: sorted.map(s => s.domain),
            datasets: [{
                label: 'Power (mWh)',
                data: sorted.map(s => Math.round(s.mwh * 1000) / 1000),
                backgroundColor: sorted.map(s => {
                    const intensity = Math.min(1, s.avgCpu / 30);
                    return `rgba(192, 57, 43, ${0.3 + intensity * 0.7})`;
                }),
                borderColor: '#C0392B',
                borderWidth: 1,
                borderRadius: 4
            }]
        },
        options: {
            indexAxis: 'y',
            responsive: true, maintainAspectRatio: false,
            scales: {
                x: { ticks: { color: '#666', callback: v => v + ' mWh' }, grid: { color: 'rgba(255,255,255,0.03)' } },
                y: { ticks: { color: '#AAA', font: { size: 10 } }, grid: { display: false } }
            },
            plugins: {
                tooltip: {
                    callbacks: {
                        afterLabel: (ctx) => `Avg CPU: ${sorted[ctx.dataIndex].avgCpu.toFixed(1)}%`
                    }
                }
            }
        }
    });
}

function renderSavingsChart(suspendEvents, cyclesByTab) {
    const buckets = {};
    for (const evt of suspendEvents) {
        const date = new Date(evt.timestamp);
        const key = analyticsRange === 'today'
            ? date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
            : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        buckets[key] = (buckets[key] || 0) + estimateEventSavings(evt, cyclesByTab);
    }

    const labels = Object.keys(buckets);
    const values = Object.values(buckets).map(v => Math.round(v * 1000) / 1000);

    destroyChart('chart-savings');
    chartInstances['chart-savings'] = new Chart(document.getElementById('chart-savings').getContext('2d'), {
        type: 'bar',
        data: {
            labels,
            datasets: [{
                label: 'Saved (mWh)',
                data: values,
                backgroundColor: 'rgba(46, 204, 113, 0.6)',
                borderColor: '#2ECC71',
                borderWidth: 1,
                borderRadius: 4
            }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            scales: {
                x: { ticks: { color: '#666', maxTicksLimit: 10 }, grid: { color: 'rgba(255,255,255,0.03)' } },
                y: { ticks: { color: '#666', callback: v => v + ' mWh' }, grid: { color: 'rgba(255,255,255,0.03)' } }
            }
        }
    });
}

// ============================================================================
// TREE EQUIVALENCY
// ============================================================================

function renderTreeSection(stats) {
    const { savedCO2, totalCO2 } = stats;

    const savedPct = (savedCO2 / TREE_CO2_PER_DAY_G) * 100;
    setText('tree-saved-val', formatGrams(savedCO2));
    setWidth('tree-saved-bar', Math.min(100, savedPct));
    const savedEquivEl = document.getElementById('tree-saved-equiv');
    if (savedEquivEl) {
        if (savedPct >= 100) {
            const trees = (savedCO2 / TREE_CO2_PER_DAY_G).toFixed(1);
            savedEquivEl.innerHTML = `Equivalent to <strong>${trees} trees'</strong> daily carbon absorption`;
        } else {
            savedEquivEl.innerHTML = `Equivalent to <strong>${savedPct.toFixed(2)}%</strong> of a tree's daily carbon absorption`;
        }
    }

    const usedPct = (totalCO2 / TREE_CO2_PER_DAY_G) * 100;
    setText('tree-used-val', formatGrams(totalCO2));
    setWidth('tree-used-bar', Math.min(100, usedPct));
    const usedEquivEl = document.getElementById('tree-used-equiv');
    if (usedEquivEl) {
        if (usedPct >= 100) {
            const trees = (totalCO2 / TREE_CO2_PER_DAY_G).toFixed(1);
            usedEquivEl.innerHTML = `Requires <strong>${trees} trees'</strong> daily work to offset`;
        } else {
            usedEquivEl.innerHTML = `Requires <strong>${usedPct.toFixed(2)}%</strong> of a tree's daily work to offset`;
        }
    }
}

// ============================================================================
// TIMELINE HELPERS
// ============================================================================

function aggregateTimeline(cycles, field) {
    const buckets = createTimeBuckets(cycles);
    // 6 decimals: CO₂ bucket sums are micro-scale in grams and would round
    // to a flat zero line at 3.
    const values = buckets.bucketCycles.map(b =>
        Math.round(b.reduce((s, c) => s + (c[field] || 0), 0) * 1e6) / 1e6
    );
    return { labels: buckets.labels, values };
}

function createTimeBuckets(cycles) {
    if (cycles.length === 0) return { labels: [], bucketCycles: [] };

    const sorted = [...cycles].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    const minT = sorted[0].timestamp;
    const maxT = sorted[sorted.length - 1].timestamp;
    const rangeMs = maxT - minT;

    let bucketMs, formatFn;
    if (rangeMs < 6 * 60 * 60 * 1000) {
        bucketMs = 5 * 60 * 1000;
        formatFn = t => new Date(t).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    } else if (rangeMs < 48 * 60 * 60 * 1000) {
        bucketMs = 30 * 60 * 1000;
        formatFn = t => new Date(t).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    } else {
        bucketMs = 24 * 60 * 60 * 1000;
        formatFn = t => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }

    // Single pass: assign each (sorted) cycle to its bucket index.
    const labels = [];
    const bucketCycles = [];
    for (const c of sorted) {
        const idx = Math.floor(((c.timestamp || 0) - minT) / bucketMs);
        while (labels.length <= idx) {
            labels.push(formatFn(minT + labels.length * bucketMs));
            bucketCycles.push([]);
        }
        bucketCycles[idx].push(c);
    }

    // Limit to max 50 buckets for readability
    if (labels.length > 50) {
        const step = Math.ceil(labels.length / 50);
        const newLabels = [], newBuckets = [];
        for (let i = 0; i < labels.length; i += step) {
            newLabels.push(labels[i]);
            const merged = [];
            for (let j = i; j < Math.min(i + step, labels.length); j++) {
                merged.push(...bucketCycles[j]);
            }
            newBuckets.push(merged);
        }
        return { labels: newLabels, bucketCycles: newBuckets };
    }

    return { labels, bucketCycles };
}

function timelineOptions(unit) {
    return {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
            x: { ticks: { maxTicksLimit: 10, color: '#666' }, grid: { color: 'rgba(255,255,255,0.03)' } },
            y: {
                ticks: {
                    color: '#666',
                    // parseFloat strips float dust (5.800000000000001 → 5.8)
                    callback: v => parseFloat(Number(v).toFixed(4)) + ' ' + unit
                },
                grid: { color: 'rgba(255,255,255,0.03)' }
            }
        },
        plugins: {
            tooltip: { mode: 'index', intersect: false }
        },
        interaction: { mode: 'nearest', axis: 'x', intersect: false }
    };
}

// ============================================================================
// UTILITIES
// ============================================================================

function destroyChart(id) {
    if (chartInstances[id]) { chartInstances[id].destroy(); delete chartInstances[id]; }
}

function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
}

/** Adaptive precision for values displayed next to a static "g" unit. */
function formatGrams(g) {
    if (g === 0) return '0';
    if (g >= 1) return g.toFixed(2);
    if (g >= 0.001) return g.toFixed(4);
    return g.toFixed(6);
}

function setWidth(id, pct) {
    const el = document.getElementById(id);
    if (el) el.style.width = Math.max(0, Math.min(100, pct)) + '%';
}

// ============================================================================
// MAIN RENDER
// ============================================================================

async function renderAnalytics() {
    try {
        if (!analyticsDB) analyticsDB = await initDB();

        const cutoff = getRangeCutoff();
        // Range-indexed reads — only 'All time' touches the full stores.
        const [cycles, suspendEvents, allSessions] = await Promise.all([
            cutoff > 0
                ? getRecordsSince(analyticsDB, 'tab_cycles', cutoff)
                : getAllRecords(analyticsDB, 'tab_cycles'),
            cutoff > 0
                ? getRecordsSince(analyticsDB, 'suspend_events', cutoff)
                : getAllRecords(analyticsDB, 'suspend_events'),
            getAllRecords(analyticsDB, 'session_meta')
        ]);

        if (cycles.length === 0) {
            ['stat-power-val', 'stat-co2-val', 'stat-power-saved-val', 'stat-co2-saved-val', 'stat-peak-cpu-val', 'stat-tabs-val'].forEach(id => setText(id, '0'));
            Object.keys(chartInstances).forEach(k => destroyChart(k));
            renderTreeSection({ savedCO2: 0, totalCO2: 0 });
            return;
        }

        const cyclesByTab = indexCyclesByTab(cycles);
        const stats = renderStatCards(cycles, suspendEvents, allSessions);
        renderPowerTimeline(cycles);
        renderCO2Timeline(cycles);
        renderCPUTimeline(cycles);
        renderDomainDonut(cycles);
        renderWorstOffenders(cycles);
        renderSavingsChart(suspendEvents, cyclesByTab);
        renderTreeSection(stats);

        const seVal = document.getElementById('savings-equiv-value');
        const seDet = document.getElementById('savings-equiv-detail');
        if (seVal && seDet) {
            const kmAvoided = (stats.savedCO2 || 0) / 130; // ~130 g CO₂ per km
            seVal.textContent = `${stats.savedMwh.toFixed(1)} mWh saved`;
            seDet.textContent = `${kmAvoided.toFixed(2)} km of driving avoided`;
        }

    } catch (e) {
        console.error('[TabVolt Analytics] Error:', e);
    }
}

// ============================================================================
// TAB SWITCHING + INIT
// ============================================================================

document.addEventListener('DOMContentLoaded', () => {
    setupChartDefaults();

    const tabBtns = document.querySelectorAll('.tab-nav-btn');
    const tabContents = document.querySelectorAll('.tab-content');

    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const target = btn.dataset.tab;
            tabBtns.forEach(b => b.classList.remove('active'));
            tabContents.forEach(c => c.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById('tab-' + target).classList.add('active');

            if (target === 'analytics') renderAnalytics();
        });
    });

    document.querySelectorAll('.range-pill').forEach(pill => {
        pill.addEventListener('click', () => {
            document.querySelectorAll('.range-pill').forEach(p => p.classList.remove('active'));
            pill.classList.add('active');
            analyticsRange = pill.dataset.range;
            renderAnalytics();
        });
    });

    renderAnalytics();
});
