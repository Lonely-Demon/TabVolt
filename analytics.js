// analytics.js — Grafana-style analytics dashboard
// Reads from IndexedDB (tab_cycles, suspend_events, session_meta)
// Renders Chart.js charts + stat cards + tree equivalency

const ADB_NAME = 'TabVoltDB';
const ADB_VERSION = 2;

// Tree CO2 absorption constant: one mature tree absorbs ~21,770 g CO2/year
const TREE_CO2_PER_DAY_G = 21770 / 365; // ~59.6 g/day

// Chart instances (for cleanup on re-render)
let chartInstances = {};
let analyticsDB = null;
let analyticsRange = 'today';

// ============================================================================
// DB ACCESS
// ============================================================================

function openAnalyticsDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(ADB_NAME, ADB_VERSION);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains('tab_cycles')) {
                const s = db.createObjectStore('tab_cycles', { keyPath: 'id', autoIncrement: true });
                s.createIndex('session_id', 'session_id', { unique: false });
                s.createIndex('domain', 'domain', { unique: false });
                s.createIndex('timestamp', 'timestamp', { unique: false });
            }
            if (!db.objectStoreNames.contains('session_meta'))
                db.createObjectStore('session_meta', { keyPath: 'session_id' });
            if (!db.objectStoreNames.contains('domain_patterns'))
                db.createObjectStore('domain_patterns', { keyPath: 'domain' });
            if (!db.objectStoreNames.contains('suspend_events')) {
                const se = db.createObjectStore('suspend_events', { keyPath: 'id', autoIncrement: true });
                se.createIndex('session_id', 'session_id', { unique: false });
                se.createIndex('timestamp', 'timestamp', { unique: false });
            }
        };
        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror = (e) => reject(e.target.error);
    });
}

function getAllRecords(db, storeName) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const req = tx.objectStore(storeName).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = (e) => reject(e.target.error);
    });
}

// ============================================================================
// TIME FILTERING
// ============================================================================

function getTimeRange() {
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

function filterByTime(records) {
    const cutoff = getTimeRange();
    return records.filter(r => (r.timestamp || 0) >= cutoff);
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
// STAT CARDS
// ============================================================================

function renderStatCards(cycles, suspendEvents, sessions) {
    const totalMwh = cycles.reduce((s, c) => s + (c.mwh_estimated || 0), 0);
    const totalCO2 = cycles.reduce((s, c) => s + (c.co2_grams || 0), 0);

    // Calculate savings: each suspend event saved energy for ~30 min (one poll cycle minimum)
    // More accurate: estimate duration until tab_id reappears or session ends
    const savedMwh = calculateSavings(suspendEvents, cycles);
    const CO2_PER_MWH = totalMwh > 0 ? totalCO2 / totalMwh : 0.82;
    const savedCO2 = savedMwh * CO2_PER_MWH;

    // Peak CPU: max sum of all tab CPU% in a single timestamp
    const cpuByTime = {};
    for (const c of cycles) {
        const t = c.timestamp || 0;
        cpuByTime[t] = (cpuByTime[t] || 0) + (c.cpu_pct || 0);
    }
    const peakCPU = Object.values(cpuByTime).length > 0
        ? Math.max(...Object.values(cpuByTime)) : 0;

    // Tabs monitored
    const tabIds = new Set(cycles.map(c => c.tab_id).filter(Boolean));
    const tabCount = tabIds.size || sessions.reduce((m, s) => Math.max(m, s.total_tabs_monitored || 0), 0);

    setText('stat-power-val', totalMwh.toFixed(1));
    setText('stat-co2-val', totalCO2.toFixed(2));
    setText('stat-power-saved-val', savedMwh.toFixed(1));
    setText('stat-co2-saved-val', savedCO2.toFixed(2));
    setText('stat-peak-cpu-val', peakCPU.toFixed(1));
    setText('stat-tabs-val', tabCount);

    return { totalMwh, totalCO2, savedMwh, savedCO2 };
}

function calculateSavings(suspendEvents, cycles) {
    if (suspendEvents.length === 0) return 0;

    let totalSaved = 0;
    for (const evt of suspendEvents) {
        // Estimate how long the tab stayed suspended
        // Find next cycle where this tab_id reappears (not discarded)
        const laterCycles = cycles.filter(c =>
            c.tab_id === evt.tab_id &&
            c.timestamp > evt.timestamp
        ).sort((a, b) => a.timestamp - b.timestamp);

        // Duration = time until tab reappears, capped at 60 minutes
        let durationMs;
        if (laterCycles.length > 0) {
            durationMs = Math.min(laterCycles[0].timestamp - evt.timestamp, 60 * 60 * 1000);
        } else {
            durationMs = 30 * 60 * 1000; // Default: 30 min if no reappearance
        }

        const durationHrs = durationMs / (60 * 60 * 1000);
        // mWh rate from event is per-cycle (~30s). Convert to hourly rate
        const hourlyRate = (evt.pre_suspend_mwh_rate || 0) * 120; // 120 cycles per hour
        totalSaved += hourlyRate * durationHrs;
    }
    return totalSaved;
}

// ============================================================================
// CHARTS
// ============================================================================

function renderPowerTimeline(cycles) {
    const data = aggregateTimelineMwh(cycles);
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
    const data = aggregateTimelineCO2(cycles);
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
                label: 'CO₂ (g)',
                data: data.values,
                borderColor: '#27AE60',
                backgroundColor: gradient,
                borderWidth: 2,
                fill: true,
                tension: 0.3
            }]
        },
        options: timelineOptions('g')
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

    // Time buckets
    const buckets = createTimeBuckets(cycles);
    const domainColors = ['#3498DB', '#E74C3C', '#F39C12', '#9B59B6', '#1ABC9C', '#95A5A6'];

    const datasets = topDomains.map((domain, i) => {
        const values = buckets.labels.map((_, bi) => {
            return buckets.bucketCycles[bi]
                .filter(c => c.domain === domain)
                .reduce((s, c) => s + (c.cpu_pct || 0), 0) / Math.max(1, buckets.bucketCycles[bi].filter(c => c.domain === domain).length);
        });
        return {
            label: domain || '(unknown)',
            data: values,
            borderColor: domainColors[i],
            backgroundColor: domainColors[i] + '40',
            borderWidth: 1.5,
            fill: true,
            tension: 0.3
        };
    });

    // Add "Other"
    const otherValues = buckets.labels.map((_, bi) => {
        return buckets.bucketCycles[bi]
            .filter(c => !topDomains.includes(c.domain))
            .reduce((s, c) => s + (c.cpu_pct || 0), 0) / Math.max(1, buckets.bucketCycles[bi].filter(c => !topDomains.includes(c.domain)).length || 1);
    });
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

    const maxMwh = sorted.length > 0 ? sorted[0].mwh : 1;

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

function renderSavingsChart(suspendEvents) {
    const buckets = {};
    for (const evt of suspendEvents) {
        const date = new Date(evt.timestamp);
        const key = analyticsRange === 'today'
            ? date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
            : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        const mwhSaved = (evt.pre_suspend_mwh_rate || 0) * 60; // Estimate 30 min savings (60 cycles)
        buckets[key] = (buckets[key] || 0) + mwhSaved;
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

    // Saved side
    const savedPct = TREE_CO2_PER_DAY_G > 0 ? (savedCO2 / TREE_CO2_PER_DAY_G) * 100 : 0;
    setText('tree-saved-val', savedCO2.toFixed(3));
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

    // Emitted side
    const usedPct = TREE_CO2_PER_DAY_G > 0 ? (totalCO2 / TREE_CO2_PER_DAY_G) * 100 : 0;
    setText('tree-used-val', totalCO2.toFixed(3));
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

function aggregateTimelineMwh(cycles) {
    const buckets = createTimeBuckets(cycles);
    const values = buckets.bucketCycles.map(b =>
        Math.round(b.reduce((s, c) => s + (c.mwh_estimated || 0), 0) * 1000) / 1000
    );
    return { labels: buckets.labels, values };
}

function aggregateTimelineCO2(cycles) {
    const buckets = createTimeBuckets(cycles);
    const values = buckets.bucketCycles.map(b =>
        Math.round(b.reduce((s, c) => s + (c.co2_grams || 0), 0) * 1000) / 1000
    );
    return { labels: buckets.labels, values };
}

function createTimeBuckets(cycles) {
    if (cycles.length === 0) return { labels: [], bucketCycles: [] };

    const sorted = [...cycles].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    const minT = sorted[0].timestamp;
    const maxT = sorted[sorted.length - 1].timestamp;
    const rangeMs = maxT - minT;

    // Choose bucket size based on range
    let bucketMs, formatFn;
    if (rangeMs < 6 * 60 * 60 * 1000) {
        // < 6 hours: 5-min buckets
        bucketMs = 5 * 60 * 1000;
        formatFn = t => new Date(t).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    } else if (rangeMs < 48 * 60 * 60 * 1000) {
        // < 2 days: 30-min buckets
        bucketMs = 30 * 60 * 1000;
        formatFn = t => new Date(t).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    } else {
        // multi-day: daily buckets
        bucketMs = 24 * 60 * 60 * 1000;
        formatFn = t => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }

    const labels = [];
    const bucketCycles = [];
    let bucketStart = minT;

    while (bucketStart <= maxT) {
        const bucketEnd = bucketStart + bucketMs;
        labels.push(formatFn(bucketStart));
        bucketCycles.push(sorted.filter(c =>
            (c.timestamp || 0) >= bucketStart && (c.timestamp || 0) < bucketEnd
        ));
        bucketStart = bucketEnd;
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
            y: { ticks: { color: '#666', callback: v => v + ' ' + unit }, grid: { color: 'rgba(255,255,255,0.03)' } }
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

function setWidth(id, pct) {
    const el = document.getElementById(id);
    if (el) el.style.width = Math.max(0, Math.min(100, pct)) + '%';
}

// ============================================================================
// MAIN RENDER
// ============================================================================

async function renderAnalytics() {
    try {
        if (!analyticsDB) analyticsDB = await openAnalyticsDB();

        const allCycles = await getAllRecords(analyticsDB, 'tab_cycles');
        const allSuspendEvents = await getAllRecords(analyticsDB, 'suspend_events');
        const allSessions = await getAllRecords(analyticsDB, 'session_meta');

        const cycles = filterByTime(allCycles);
        const suspendEvents = filterByTime(allSuspendEvents);

        if (cycles.length === 0) {
            // Show empty state for all stat cards
            ['stat-power-val', 'stat-co2-val', 'stat-power-saved-val', 'stat-co2-saved-val', 'stat-peak-cpu-val', 'stat-tabs-val'].forEach(id => setText(id, '0'));
            // Destroy existing charts
            Object.keys(chartInstances).forEach(k => destroyChart(k));
            renderTreeSection({ savedCO2: 0, totalCO2: 0 });
            return;
        }

        const stats = renderStatCards(cycles, suspendEvents, allSessions);
        renderPowerTimeline(cycles);
        renderCO2Timeline(cycles);
        renderCPUTimeline(cycles);
        renderDomainDonut(cycles);
        renderWorstOffenders(cycles);
        renderSavingsChart(suspendEvents);
        renderTreeSection(stats);

    } catch (e) {
        console.error('[TabVolt Analytics] Error:', e);
    }
}

// ============================================================================
// TAB SWITCHING + INIT
// ============================================================================

document.addEventListener('DOMContentLoaded', () => {
    setupChartDefaults();

    // Tab navigation
    const tabBtns = document.querySelectorAll('.tab-nav-btn');
    const tabContents = document.querySelectorAll('.tab-content');

    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const target = btn.dataset.tab;
            tabBtns.forEach(b => b.classList.remove('active'));
            tabContents.forEach(c => c.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById('tab-' + target).classList.add('active');

            // Trigger chart render when analytics tab is activated
            if (target === 'analytics') renderAnalytics();
        });
    });

    // Analytics range pills
    document.querySelectorAll('.range-pill').forEach(pill => {
        pill.addEventListener('click', () => {
            document.querySelectorAll('.range-pill').forEach(p => p.classList.remove('active'));
            pill.classList.add('active');
            analyticsRange = pill.dataset.range;
            renderAnalytics();
        });
    });

    // Auto-render analytics on load (it's the default tab)
    renderAnalytics();
});
