// background.js — Service Worker (ES Module)
//
// Architecture notes:
// - All listeners are registered synchronously at top level (MV3 requirement).
// - The poll loop is a self-scheduling setTimeout chain with a reentrancy
//   guard — cycles can never overlap, and the adaptive interval applies
//   without tearing down timers.
// - Hot state (heatmap, domain patterns, aggregation buffer) lives in memory;
//   IndexedDB is only touched on a 30s flush cadence, not per cycle.
// - Battery state arrives from an offscreen document (offscreen.js) because
//   the Battery Status API does not exist in service workers.
// - Session identity/totals persist in chrome.storage.session so a service
//   worker restart continues the same session instead of fragmenting it.

import {
    computeEnergyScore, getScoreTier, getTierColor,
    estimateMwh, estimateCO2g, getAdaptiveInterval, isRestrictedUrl,
    computeMemoryWeight, BROWSER_MEM_SHARE_ASSUMPTION
} from './energyscore.js';

import {
    initDB, writeTabCycle, writeSessionMeta, writeSuspendEvent,
    putDomainPatterns, getAllDomainPatterns, pruneAll
} from './storage.js';

// ============================================================================
// CONFIGURATION
// ============================================================================

const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const AI_MODEL = 'llama-3.1-8b-instant';

const FLUSH_INTERVAL_MS = 30000;      // aggregate window for DB writes
const HEATMAP_CYCLES = 30;            // rolling buffer length per tab
const BATTERY_HISTORY_LEN = 5;        // readings kept for drain-rate estimate
const BUDGET_NOTIFY_COOLDOWN_MS = 5 * 60 * 1000;
const DEFAULT_SETTINGS = { autoSuspendMins: 5 };

// ============================================================================
// MODULE-LEVEL STATE — declared before any function runs
// ============================================================================

let db = null;
let initPromise = null;

let pollTimer = null;
let polling = false;                  // reentrancy guard
let currentIntervalMs = 5000;
let lastCycleTime = 0;                // for measured energy integration

// Session identity — restored from chrome.storage.session on SW restart.
let session = null;                   // { id, startTime, cycleCount, totalMwh, totalCO2g }

// Battery — null until the offscreen document reports.
let battery = null;                   // { pct, charging }
const batteryHistory = [];
let notifiedBatteryCritical = false;
let lastBudgetNotificationTime = 0;

let settings = { ...DEFAULT_SETTINGS };
let protectedTabs = [];               // [{ tabId, domain, title, protected_since }]

const networkBytes = new Map();       // tabId -> bytes since last cycle
let prevCpuInfo = null;
let sleepingTabs = new Set();         // tabIds with the sleep patch applied
const tabDomains = new Map();         // tabId -> current domain (pattern events)

let heatmap = null;                   // tabId -> { title, favicon, url, order, scores[] }
const domainPatterns = new Map();     // domain -> pattern record (write-through cache)
const dirtyDomains = new Set();       // domains needing persistence at next flush

const aggBuffer = new Map();          // tabId -> per-window aggregate for DB
let lastFlushTime = Date.now();
let lastTabPayloads = [];             // last cycle's payloads (for suspend logging)

// ============================================================================
// TOP-LEVEL LISTENERS — registered synchronously before any async work
// ============================================================================

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
    event.waitUntil(clients.claim().then(() => initialize()));
});

// Network byte accounting. Responses without Content-Length (streams, chunked)
// are counted as a flat 512 bytes — a deliberate, cheap underestimate.
chrome.webRequest.onCompleted.addListener(
    (details) => {
        if (details.tabId <= 0) return;
        let bytes = 0;
        if (details.responseHeaders) {
            const cl = details.responseHeaders.find(h => h.name.toLowerCase() === 'content-length');
            bytes = cl ? parseInt(cl.value, 10) || 0 : 0;
        }
        networkBytes.set(details.tabId, (networkBytes.get(details.tabId) || 0) + (bytes || 512));
    },
    { urls: ['<all_urls>'] },
    ['responseHeaders']
);

// Keepalive — re-arms the poll loop if the SW was restarted.
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'keepalive') {
        initialize().then(() => {
            if (pollTimer === null && !polling) schedulePoll(0);
        });
    }
});

// --- Pattern learning is event-driven: opens and returns are real events, ---
// --- not poll samples, so the counters mean what their names say.         ---

chrome.tabs.onCreated.addListener((tab) => {
    const domain = extractDomain(tab.pendingUrl || tab.url || '');
    if (!domain) return;
    tabDomains.set(tab.id, domain);
    initialize().then(() => recordDomainOpen(domain));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    // A navigation destroys any injected sleep patch — drop stale state.
    if (changeInfo.status === 'loading') sleepingTabs.delete(tabId);
    if (changeInfo.url) {
        const domain = extractDomain(changeInfo.url);
        if (domain && domain !== tabDomains.get(tabId)) {
            tabDomains.set(tabId, domain);
            initialize().then(() => recordDomainOpen(domain));
        }
    }
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
    initialize().then(async () => {
        try {
            const tab = await chrome.tabs.get(tabId);
            const domain = extractDomain(tab.url || tab.pendingUrl || '');
            if (domain) recordDomainReturn(domain);
        } catch (_) { /* tab already gone */ }
    });
});

chrome.tabs.onRemoved.addListener((tabId) => {
    networkBytes.delete(tabId);
    sleepingTabs.delete(tabId);
    tabDomains.delete(tabId);
});

// React to settings changes without polling storage.
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) {
        settings = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
    }
});

// ============================================================================
// LOCAL DEV CONVENIENCE — optional, never committed, never required
// ============================================================================

/**
 * Seed the Groq API key from an optional `config.local.json` on first run
 * only (i.e. whenever chrome.storage.local has none saved yet). That file is
 * git-ignored and lives only on your disk, so unlike chrome.storage.local —
 * which Chrome wipes when you *remove* the extension, as opposed to just
 * clicking "Reload" — it survives a full remove-and-"Load unpacked" cycle.
 * Purely a convenience for local development; the popup's Settings drawer
 * works exactly the same with or without this file, and it never overwrites
 * a key you've already set or changed there.
 *
 * Uses fetch(), not an ES import: dynamic import() is disallowed inside a
 * service worker by the HTML spec, and a static import of a file that may
 * not exist would fail the whole service worker's module graph to load.
 */
async function seedLocalDevApiKey() {
    try {
        const existing = await chrome.storage.local.get('groqApiKey');
        if (existing.groqApiKey) return;
        const res = await fetch(chrome.runtime.getURL('config.local.json'));
        if (!res.ok) return;
        const data = await res.json();
        if (data?.groqApiKey) {
            await chrome.storage.local.set({ groqApiKey: data.groqApiKey });
        }
    } catch (_) {
        // Normal for most installs — config.local.json is optional and
        // git-ignored, so it usually doesn't exist.
    }
}

// ============================================================================
// INITIALIZE — idempotent; safe to call from every entry point
// ============================================================================

function initialize() {
    if (!initPromise) initPromise = doInitialize();
    return initPromise;
}

async function doInitialize() {
    try {
        db = await initDB();
        await pruneAll(db);
    } catch (e) {
        console.warn('TabVolt: DB init failed', e);
    }

    // Restore persisted config.
    try {
        const stored = await chrome.storage.local.get(['protectedTabs', 'settings']);
        protectedTabs = stored.protectedTabs || [];
        settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
    } catch (_) { protectedTabs = []; }

    await seedLocalDevApiKey();

    // Restore session state so an SW restart continues the same session.
    try {
        const s = await chrome.storage.session.get(['session', 'poll', 'heatmap_buffer', 'sleeping_tabs']);
        if (s.session?.session_id) {
            session = {
                id: s.session.session_id,
                startTime: s.session.start_time,
                cycleCount: s.poll?.cycle_count || 0,
                totalMwh: s.session.total_mwh || 0,
                totalCO2g: s.session.total_co2_grams || 0
            };
        }
        heatmap = s.heatmap_buffer || {};
        sleepingTabs = new Set(s.sleeping_tabs || []);
    } catch (_) { heatmap = {}; }

    if (!session) {
        session = {
            id: crypto.randomUUID(),
            startTime: Date.now(),
            cycleCount: 0,
            totalMwh: 0,
            totalCO2g: 0
        };
    }

    // Warm the domain-pattern cache (single read at startup, zero per-cycle reads).
    try {
        const patterns = await getAllDomainPatterns(db);
        for (const p of patterns) domainPatterns.set(p.domain, p);
    } catch (_) { }

    // Seed tab->domain map for pattern events.
    try {
        const tabs = await chrome.tabs.query({});
        for (const t of tabs) {
            const d = extractDomain(t.url || '');
            if (d) tabDomains.set(t.id, d);
        }
    } catch (_) { }

    // Fire-and-forget: battery telemetry is optional and createDocument can
    // stall on some platforms — it must never gate the poll engine.
    ensureOffscreenDocument();

    chrome.alarms.clearAll(() => {
        chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
    });

    schedulePoll(0);
}

// Boot — safe here because all state and listeners are declared above.
initialize();

// ============================================================================
// OFFSCREEN DOCUMENT — battery telemetry
// ============================================================================

async function ensureOffscreenDocument() {
    try {
        if (chrome.runtime.getContexts) {
            const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
            if (contexts.length > 0) return;
        }
        await chrome.offscreen.createDocument({
            url: 'offscreen.html',
            reasons: ['BATTERY_STATUS'],
            justification: 'Read battery level and charging state for adaptive polling and the energy budget.'
        });
    } catch (e) {
        // "Only a single offscreen document" race, or unsupported platform.
        console.debug('TabVolt: offscreen document', e.message);
    }
}

// ============================================================================
// POLL LOOP — self-scheduling, non-reentrant
// ============================================================================

function schedulePoll(delayMs) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(runPollCycle, delayMs);
}

async function runPollCycle() {
    if (polling) return;
    polling = true;
    pollTimer = null;

    try {
        await initialize();
        const now = Date.now();
        const elapsedSecs = lastCycleTime
            ? Math.min(Math.max((now - lastCycleTime) / 1000, 1), 120)
            : currentIntervalMs / 1000;
        lastCycleTime = now;
        session.cycleCount++;

        const [tabs, cpuInfo, memInfo] = await Promise.all([
            chrome.tabs.query({}),
            chrome.system.cpu.getInfo(),
            chrome.system.memory.getInfo()
        ]);

        // ---- System CPU delta ----
        let systemCpuPct = 0;
        if (cpuInfo?.processors && prevCpuInfo?.processors?.length === cpuInfo.processors.length) {
            let tot = 0, idl = 0;
            for (let i = 0; i < cpuInfo.processors.length; i++) {
                const c = cpuInfo.processors[i].usage;
                const p = prevCpuInfo.processors[i]?.usage;
                if (p) { tot += c.total - p.total; idl += c.idle - p.idle; }
            }
            systemCpuPct = tot > 0 ? ((tot - idl) / tot) * 100 : 0;
        }
        prevCpuInfo = cpuInfo;
        systemCpuPct = round1(systemCpuPct);

        const memoryPct = memInfo
            ? round1(((memInfo.capacity - memInfo.availableCapacity) / memInfo.capacity) * 100) : 0;
        const usedRamMB = memInfo
            ? Math.round((memInfo.capacity - memInfo.availableCapacity) / 1048576) : 0;

        const batteryPct = battery ? battery.pct : null;
        const isCharging = battery ? battery.charging : null;

        // ---- Heuristic per-tab CPU and memory weights (single pass) ----
        // Two independent weight formulas on purpose — memory uses different
        // signals (media/loading/network, no idle decay) so the RAM column
        // isn't just a rescaled copy of the CPU column.
        const browserCpuEst = systemCpuPct * 0.6;
        const browserMemEst = memoryPct * BROWSER_MEM_SHARE_ASSUMPTION;
        const tabWeights = new Map();
        const memWeights = new Map();
        let totalWeight = 0;
        let totalMemWeight = 0;
        for (const tab of tabs) {
            if (tab.discarded) { tabWeights.set(tab.id, 0); memWeights.set(tab.id, 0); continue; }
            const isLoading = tab.status === 'loading';
            const netKB = (networkBytes.get(tab.id) || 0) / 1024;

            let w = 1;
            if (tab.active) w += 30;
            if (tab.audible) w += 20;
            if (isLoading) w += 15;
            w += Math.min(netKB / 5, 15);
            tabWeights.set(tab.id, w);
            totalWeight += w;

            const mw = computeMemoryWeight(tab.audible, isLoading, netKB, tab.active);
            memWeights.set(tab.id, mw);
            totalMemWeight += mw;
        }

        // ---- Per-tab payloads + aggregation (single pass) ----
        const tabPayloads = [];
        for (const tab of tabs) {
            const weight = tabWeights.get(tab.id) || 0;
            const tabCpuPct = totalWeight > 0 ? (weight / totalWeight) * browserCpuEst : 0;
            const memWeight = memWeights.get(tab.id) || 0;
            const tabRamPct = (!tab.discarded && totalMemWeight > 0) ? (memWeight / totalMemWeight) * browserMemEst : 0;
            const idleMins = (now - (tab.lastAccessed ?? now)) / 60000;
            const kbThisCycle = (networkBytes.get(tab.id) ?? 0) / 1024;
            networkBytes.delete(tab.id);
            const isBackground = !tab.active;

            let score = 0, mwh = 0, co2 = 0;
            if (!tab.discarded) {
                score = computeEnergyScore(tabCpuPct, idleMins, kbThisCycle, isBackground);
                mwh = estimateMwh(tabCpuPct, elapsedSecs);
                co2 = estimateCO2g(mwh);
            }

            const tier = getScoreTier(score);
            const domain = extractDomain(tab.url);
            session.totalMwh += mwh;
            session.totalCO2g += co2;

            let state = 'normal';
            if (tab.discarded) state = 'suspended';
            else if (sleepingTabs.has(tab.id)) state = 'sleeping';

            const pattern = domain ? domainPatterns.get(domain) : null;

            tabPayloads.push({
                tabId: tab.id, title: tab.title || 'Untitled',
                url: tab.url || '', domain, favicon: tab.favIconUrl || '',
                energyscore: Math.round(score),
                cpu_pct: round1(tabCpuPct),
                ram_pct: round1(tabRamPct),
                kb_transferred: round2(kbThisCycle),
                idle_mins: round2(idleMins),
                is_background: isBackground, is_active: tab.active || false,
                mwh_estimated: round4(mwh),
                co2_grams: round6(co2),
                tier, tierColor: getTierColor(tier), state,
                audible: tab.audible || false,
                pinned: tab.pinned || false,
                // Both "share of system X" figures a tab is estimated to
                // account for — neither is a real per-tab measurement.
                // Chrome Stable doesn't expose that to extensions at all
                // (see Context/Phase1_Iteration_Log.md); these are heuristic
                // splits of a real system-wide total, not process readings.
                browser_cpu_share: browserCpuEst > 0 ? round1((tabCpuPct / browserCpuEst) * 100) : 0,
                browser_mem_share: totalMemWeight > 0 ? round1((memWeight / totalMemWeight) * 100) : 0,
                is_protected: isTabProtected(tab.id, domain),
                preemptive_flag: pattern?.preemptive_flag || false
            });

            // Aggregate for the DB flush window.
            if (!tab.discarded) {
                let a = aggBuffer.get(tab.id);
                if (!a) {
                    a = {
                        tab_id: tab.id, domain, title: tab.title || 'Untitled', url: tab.url || '',
                        cpuSum: 0, kbSum: 0, mwhSum: 0, co2Sum: 0,
                        idleMax: 0, scoreMax: 0, samples: 0, is_background: isBackground
                    };
                    aggBuffer.set(tab.id, a);
                }
                a.domain = domain;
                a.title = tab.title || 'Untitled';
                a.url = tab.url || '';
                a.cpuSum += tabCpuPct;
                a.kbSum += kbThisCycle;
                a.mwhSum += mwh;
                a.co2Sum += co2;
                a.idleMax = Math.max(a.idleMax, idleMins);
                a.scoreMax = Math.max(a.scoreMax, score);
                a.is_background = isBackground;
                a.samples++;
            }
        }
        lastTabPayloads = tabPayloads;

        // ---- Heatmap rolling buffer (in memory; persisted with the batch below) ----
        const liveIds = new Set();
        tabPayloads.forEach((t, idx) => {
            const key = String(t.tabId);
            liveIds.add(key);
            let h = heatmap[key];
            if (!h) { h = { scores: [] }; heatmap[key] = h; }
            h.title = t.title; h.favicon = t.favicon; h.url = t.url; h.order = idx;
            h.scores.push(t.energyscore);
            if (h.scores.length > HEATMAP_CYCLES) h.scores.shift();
        });
        for (const key of Object.keys(heatmap)) {
            if (!liveIds.has(key)) delete heatmap[key];
        }

        // ---- Energy Budget evaluation (needs a real battery reading) ----
        const budgetState = await evaluateBudget(now, batteryPct, isCharging, tabPayloads);

        // ---- Single session-storage write per cycle ----
        const durationMins = (now - session.startTime) / 60000;
        try {
            await chrome.storage.session.set({
                tabs: tabPayloads,
                system: {
                    cpu_pct: systemCpuPct, memory_pct: memoryPct,
                    battery_pct: batteryPct, is_charging: isCharging
                },
                browser_totals: { cpu_pct: round1(browserCpuEst), ram_mb: usedRamMB },
                session: {
                    session_id: session.id, start_time: session.startTime,
                    duration_mins: round1(durationMins),
                    total_mwh: round3(session.totalMwh),
                    total_co2_grams: round6(session.totalCO2g)
                },
                poll: { interval_ms: currentIntervalMs, cycle_count: session.cycleCount, last_updated: now },
                heatmap_buffer: heatmap,
                sleeping_tabs: [...sleepingTabs],
                budget: budgetState
            });
        } catch (e) { console.debug('TabVolt: session write failed', e.message); }

        // ---- DB flush on the aggregate cadence, not per cycle ----
        if (now - lastFlushTime >= FLUSH_INTERVAL_MS) {
            await flushToDB(now);
        }

        // ---- Auto-suspend idle background tabs ----
        if (settings.autoSuspendMins > 0) {
            const candidates = suspendableFrom(tabPayloads)
                .filter(t => (t.idle_mins || 0) >= settings.autoSuspendMins);
            for (const t of candidates) {
                await suspendTab(t.tabId, 'auto').catch(() => { });
            }
        }

        // ---- Battery-critical protection ----
        if (batteryPct !== null && batteryPct < 15 && isCharging === false && !notifiedBatteryCritical) {
            notifiedBatteryCritical = true;
            notify('battery-critical', 'TabVolt — Battery Critical',
                'Suspending top drain tabs to extend battery.');
            const critical = suspendableFrom(tabPayloads)
                .sort((a, b) => b.energyscore - a.energyscore)
                .slice(0, 3);
            for (const t of critical) {
                await suspendTab(t.tabId, 'auto').catch(() => { });
            }
        }
        if (batteryPct !== null && batteryPct > 20) notifiedBatteryCritical = false;

        // ---- Adaptive cadence ----
        currentIntervalMs = getAdaptiveInterval(batteryPct, systemCpuPct, isCharging ?? true);
    } catch (err) {
        console.error('TabVolt: Poll error:', err);
    } finally {
        polling = false;
        schedulePoll(currentIntervalMs);
    }
}

// ============================================================================
// DB FLUSH — one write batch per 30s window
// ============================================================================

async function flushToDB(now) {
    const windowMs = now - lastFlushTime;
    lastFlushTime = now;

    const records = [];
    for (const a of aggBuffer.values()) {
        if (a.samples === 0) continue;
        records.push({
            session_id: session.id, timestamp: now, tab_id: a.tab_id,
            domain: a.domain, title: a.title, url: a.url,
            energyscore: Math.round(a.scoreMax),
            cpu_pct: round1(a.cpuSum / a.samples),
            kb_transferred: round2(a.kbSum),
            idle_mins: round2(a.idleMax),
            is_background: a.is_background,
            mwh_estimated: round4(a.mwhSum),
            co2_grams: round6(a.co2Sum),
            window_ms: windowMs,
            samples: a.samples
        });

        // Idle EMA feeds the preemptive heuristic; update once per window.
        if (a.domain && domainPatterns.has(a.domain)) {
            const p = domainPatterns.get(a.domain);
            p.avg_idle_mins = p.avg_idle_mins * 0.8 + a.idleMax * 0.2;
            p.preemptive_flag = computePreemptive(p);
            dirtyDomains.add(a.domain);
        }
    }
    aggBuffer.clear();

    try {
        await writeTabCycle(db, records);
        await writeSessionMeta(db, {
            session_id: session.id, start_time: session.startTime, end_time: now,
            total_tabs_monitored: records.length,
            total_mwh: session.totalMwh, total_co2_grams: session.totalCO2g
        });
        if (dirtyDomains.size > 0) {
            const dirty = [...dirtyDomains].map(d => domainPatterns.get(d)).filter(Boolean);
            dirtyDomains.clear();
            await putDomainPatterns(db, dirty);
        }
    } catch (e) {
        console.debug('TabVolt: DB flush failed', e.message);
    }
}

// ============================================================================
// ENERGY BUDGET
// ============================================================================

async function evaluateBudget(now, batteryPct, isCharging, tabPayloads) {
    let budget;
    try {
        budget = (await chrome.storage.local.get('energyBudget')).energyBudget;
    } catch (_) { return { active: false }; }
    if (!budget) return { active: false };

    if (batteryPct === null) {
        return {
            active: true, targetPct: budget.targetPct, targetTime: budget.targetTime,
            batteryUnavailable: true, onTrack: true, remainingMins: null, lastAction: null
        };
    }

    const remainingMins = (new Date(budget.targetTime).getTime() - now) / 60000;
    const availablePct = batteryPct - budget.targetPct;

    if (remainingMins <= 0 || availablePct <= 0) {
        await chrome.storage.local.remove('energyBudget');
        notify('budget-complete', 'TabVolt — Budget Complete', 'Your energy budget period has ended.');
        batteryHistory.length = 0;
        return { active: false };
    }

    batteryHistory.push({ pct: batteryPct, time: now });
    if (batteryHistory.length > BATTERY_HISTORY_LEN) batteryHistory.shift();

    let drainPctPerMin = 0;
    if (batteryHistory.length >= 2) {
        const oldest = batteryHistory[0];
        const newest = batteryHistory[batteryHistory.length - 1];
        const elapsed = (newest.time - oldest.time) / 60000;
        if (elapsed > 0) drainPctPerMin = (oldest.pct - newest.pct) / elapsed;
    }

    const projectedDrainPct = drainPctPerMin * remainingMins;
    const onTrack = isCharging || projectedDrainPct <= availablePct;
    let lastAction = null;

    if (!onTrack) {
        const candidate = suspendableFrom(tabPayloads)
            .sort((a, b) => b.energyscore - a.energyscore)[0];
        if (candidate) {
            try {
                await suspendTab(candidate.tabId, 'budget');
                lastAction = `Suspended "${candidate.title}"`;
            } catch (_) { }

            if (now - lastBudgetNotificationTime > BUDGET_NOTIFY_COOLDOWN_MS) {
                lastBudgetNotificationTime = now;
                notify('budget-exceeded', 'TabVolt — Budget Action',
                    'Tab suspended to stay within your battery budget.');
            }
        }
    }

    return {
        active: true, targetPct: budget.targetPct, targetTime: budget.targetTime,
        remainingMins: Math.round(remainingMins), onTrack, lastAction
    };
}

// ============================================================================
// PATTERN LEARNING — event-driven
// ============================================================================

function computePreemptive(p) {
    return p.open_count >= 5 &&
        (p.returned_count / p.open_count) < 0.25 &&
        p.avg_idle_mins > 8;
}

function recordDomainOpen(domain) {
    let p = domainPatterns.get(domain);
    if (!p) {
        p = { domain, open_count: 0, returned_count: 0, avg_idle_mins: 0, last_seen: 0, preemptive_flag: false };
        domainPatterns.set(domain, p);
    }
    p.open_count++;
    p.last_seen = Date.now();
    p.preemptive_flag = computePreemptive(p);
    dirtyDomains.add(domain);
}

function recordDomainReturn(domain) {
    const p = domainPatterns.get(domain);
    if (!p) return;
    p.returned_count++;
    p.last_seen = Date.now();
    p.preemptive_flag = computePreemptive(p);
    dirtyDomains.add(domain);
}

// ============================================================================
// SUSPEND / SLEEP / WAKE
// ============================================================================

function isTabProtected(tabId, domain) {
    return protectedTabs.some(p => p.tabId === tabId || (domain && p.domain === domain));
}

/** TabVolt's own pages (history, popup-in-a-tab) are never suspend targets. */
function isSelfPage(url) {
    return (url || '').startsWith(chrome.runtime.getURL(''));
}

/** The one filter for "safe to suspend automatically". */
function suspendableFrom(tabPayloads) {
    return tabPayloads.filter(t =>
        t.is_background && t.state === 'normal' &&
        !t.audible && !t.pinned && !t.is_protected && !isSelfPage(t.url)
    );
}

async function suspendTab(tabId, trigger) {
    let domain = '';
    try {
        const t = await chrome.tabs.get(tabId);
        domain = extractDomain(t.url);
    } catch (e) {
        throw new Error(e.message);
    }
    if (isTabProtected(tabId, domain)) throw new Error('Tab is protected');

    await logSuspendEvent(tabId, trigger);
    await chrome.tabs.discard(tabId);
    sleepingTabs.delete(tabId);
}

/** Translate Chrome's internal scripting errors into something a user can act on. */
function friendlyScriptError(message) {
    if (/cannot access contents|extension manifest must request permission/i.test(message)) {
        return "Chrome doesn't allow extensions to modify this kind of page";
    }
    if (/no tab with id/i.test(message)) return 'Tab was closed';
    return 'Could not modify this tab';
}

async function sleepTab(tabId) {
    let info;
    try {
        info = await chrome.tabs.get(tabId);
    } catch (e) { return { success: false, error: friendlyScriptError(e.message) }; }
    if (info.discarded) return { success: false, error: 'Tab is suspended' };
    if (isRestrictedUrl(info.url)) {
        return { success: false, error: "Chrome doesn't allow extensions to modify this kind of page" };
    }

    try {
        // MAIN world: patching requestAnimationFrame in the isolated world
        // would not affect the page's own scripts.
        await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: () => {
                if (document.getElementById('tabvolt-sleep')) return;
                const s = document.createElement('style');
                s.id = 'tabvolt-sleep';
                s.textContent = '*, *::before, *::after { animation-play-state: paused !important; transition: none !important; }';
                document.documentElement.appendChild(s);
                window.__tabvolt_raf = window.requestAnimationFrame;
                window.requestAnimationFrame = () => 0;
            }
        });
        sleepingTabs.add(tabId);
        return { success: true };
    } catch (e) { return { success: false, error: friendlyScriptError(e.message) }; }
}

async function wakeTab(tabId) {
    try {
        await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: () => {
                const s = document.getElementById('tabvolt-sleep');
                if (s) s.remove();
                if (window.__tabvolt_raf) {
                    window.requestAnimationFrame = window.__tabvolt_raf;
                    delete window.__tabvolt_raf;
                }
            }
        });
        sleepingTabs.delete(tabId);
        return { success: true };
    } catch (e) { return { success: false, error: friendlyScriptError(e.message) }; }
}

async function logSuspendEvent(tabId, trigger) {
    try {
        const tabData = lastTabPayloads.find(t => t.tabId === tabId);
        if (!tabData || !db) return;

        const cycleSecs = Math.max(currentIntervalMs / 1000, 1);
        await writeSuspendEvent(db, {
            session_id: session.id,
            timestamp: Date.now(),
            tab_id: tabId,
            domain: tabData.domain || '',
            title: tabData.title || 'Untitled',
            pre_suspend_score: tabData.energyscore || 0,
            pre_suspend_cpu: tabData.cpu_pct || 0,
            // Rate captured with the interval it was measured at, so
            // analytics never has to guess the cycle length.
            mwh_per_hour: round4((tabData.mwh_estimated || 0) * (3600 / cycleSecs)),
            poll_interval_ms: currentIntervalMs,
            trigger
        });
    } catch (e) {
        console.warn('[TabVolt] Failed to log suspend event:', e);
    }
}

// ============================================================================
// AI — the model only ever sees pre-filtered suspendable candidates, and the
// action target is resolved locally from its numbered pick. It cannot name a
// tab outside its input, and "Act Now" suspends exactly the tab it named.
// ============================================================================

async function getAISuggestion() {
    const state = await chrome.storage.session.get(['tabs', 'system', 'session']);
    const allTabs = state.tabs || [];
    const sys = state.system || {};
    const sess = state.session || {};

    const activeTabs = allTabs.filter(t => t.is_active);
    const audioTabs = allTabs.filter(t => t.audible && !t.is_active);
    const candidates = allTabs.filter(t =>
        !t.is_active && !t.audible && !t.pinned && !t.is_protected &&
        t.state === 'normal' && !isSelfPage(t.url)
    ).sort((a, b) => b.energyscore - a.energyscore).slice(0, 6);
    const suspendedTabs = allTabs.filter(t => t.state === 'suspended');

    if (candidates.length === 0) {
        const contextTabs = [...activeTabs, ...audioTabs].map(t => `"${t.title}"`).join(', ');
        const suggestion = suspendedTabs.length > 0
            ? `All background tabs are already suspended. Currently active: ${contextTabs || 'no other tabs'}. Your browser is well-optimized right now.`
            : `Only active, protected, or audio-playing tabs remain open: ${contextTabs}. These cannot be suspended. No action needed.`;
        return { suggestion, targetTabId: null, targetTitle: null };
    }

    const activeContext = activeTabs.map(t => `"${t.title}" (you are using this)`).join(', ');
    const audioContext = audioTabs.map(t => `"${t.title}" (playing audio — do not disturb)`).join(', ');
    const candidateList = candidates.map((t, i) =>
        `${i + 1}. "${t.title}" | score:${t.energyscore} | cpu:${t.cpu_pct}% | idle:${Math.round(t.idle_mins)}m`
    ).join('\n');

    const systemPrompt = `You are a browser energy optimizer for TabVolt.
STRICT RULES — violations will confuse the user:
1. NEVER suggest action on tabs marked "you are using this" or "playing audio".
2. ONLY pick a tab from the numbered CANDIDATES list.
3. Reply in this exact format: the chosen candidate number in square brackets, then a 1-2 sentence explanation naming that tab. Example: [2] "Old News Article" has been idle for 45 minutes and keeps polling the network. Suspend it to reclaim energy.`;

    const userPrompt = `Battery: ${sys.battery_pct ?? '--'}% (${sys.is_charging ? 'charging' : 'on battery'}) | CPU: ${sys.cpu_pct ?? '--'}%
Session: ${Math.round(sess.duration_mins || 0)} min

CURRENTLY IN USE (do NOT touch):
${activeContext || 'none'}
${audioContext ? `\nAUDIO PLAYING (do NOT touch):\n${audioContext}` : ''}

CANDIDATES you may suggest suspending (ranked by energy waste):
${candidateList}

Which single candidate should be suspended first and why?`;

    try {
        const keyData = await chrome.storage.local.get('groqApiKey');
        const apiKey = keyData.groqApiKey;
        if (!apiKey) {
            return {
                suggestion: 'No API key configured. Open Settings and add your Groq key.',
                targetTabId: null, targetTitle: null
            };
        }

        const res = await fetch(GROQ_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: AI_MODEL,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                max_tokens: 120,
                temperature: 0.2
            }),
            signal: AbortSignal.timeout(15000)
        });

        if (!res.ok) {
            const body = await res.text().catch(() => '');
            console.error('TabVolt AI error:', res.status, body);
            const suggestion = res.status === 401
                ? 'AI error: invalid API key. Update your Groq key in Settings.'
                : res.status === 429
                    ? 'AI rate limited. Try again shortly.'
                    : `AI error ${res.status}. Try again.`;
            return { suggestion, targetTabId: null, targetTitle: null };
        }

        const data = await res.json();
        const content = data?.choices?.[0]?.message?.content?.trim() || '';
        if (!content) return { suggestion: 'No suggestion available.', targetTabId: null, targetTitle: null };

        // Resolve the model's numbered pick locally; fall back to the top candidate.
        const match = content.match(/\[(\d+)\]/);
        const idx = match ? parseInt(match[1], 10) - 1 : 0;
        const target = candidates[idx] ?? candidates[0];
        const suggestion = content.replace(/^\s*\[\d+\]\s*/, '');

        return { suggestion, targetTabId: target.tabId, targetTitle: target.title };
    } catch (e) {
        console.error('TabVolt AI error:', e.message);
        return { suggestion: 'Unable to reach AI. Check your connection.', targetTabId: null, targetTitle: null };
    }
}

// ============================================================================
// HELPERS
// ============================================================================

function extractDomain(url) {
    try { return new URL(url).hostname; } catch (_) { return ''; }
}

function notify(id, title, message) {
    try {
        chrome.notifications.create(id, {
            type: 'basic', iconUrl: 'icons/icon48.png', title, message
        });
    } catch (_) { }
}

function round1(n) { return Math.round(n * 10) / 10; }
function round2(n) { return Math.round(n * 100) / 100; }
function round3(n) { return Math.round(n * 1000) / 1000; }
function round4(n) { return Math.round(n * 10000) / 10000; }
// CO₂ values are tiny in grams (~µg per cycle) — keep 6 decimals so
// aggregation doesn't round them into zero.
function round6(n) { return Math.round(n * 1e6) / 1e6; }

// ============================================================================
// MESSAGE HANDLER
// ============================================================================

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message.type) {
        case 'BATTERY_UPDATE':
            battery = { pct: message.level, charging: message.charging };
            return false;

        case 'BATTERY_UNAVAILABLE':
            battery = null;
            return false;

        case 'SUSPEND_TAB':
        case 'SUSPEND_SPECIFIC':
            suspendTab(message.tabId, message.type === 'SUSPEND_TAB' ? 'manual' : 'ai')
                .then(() => sendResponse({ success: true }))
                .catch((e) => sendResponse({ success: false, error: e.message }));
            return true;

        case 'SLEEP_TAB':
            sleepTab(message.tabId).then(sendResponse);
            return true;

        case 'WAKE_TAB':
            wakeTab(message.tabId).then(sendResponse);
            return true;

        case 'SUSPEND_TOP_N': {
            const n = message.n || 3;
            (async () => {
                const state = await chrome.storage.session.get(['tabs']);
                const candidates = suspendableFrom(state.tabs || [])
                    .sort((a, b) => b.energyscore - a.energyscore);
                let suspended = 0;
                for (const t of candidates) {
                    if (suspended >= n) break;
                    try {
                        await suspendTab(t.tabId, 'bulk');
                        suspended++;
                    } catch (_) { }
                }
                sendResponse({ success: true, suspended });
            })();
            return true;
        }

        case 'GET_STATE':
            chrome.storage.session.get(null, (data) => sendResponse(data || {}));
            return true;

        case 'GET_AI_SUGGESTION':
            getAISuggestion().then(sendResponse);
            return true;

        case 'SET_BUDGET':
            (async () => {
                await chrome.storage.local.set({
                    energyBudget: { targetPct: message.targetPct, targetTime: message.targetTime, setAt: Date.now() }
                });
                sendResponse({ success: true });
            })();
            return true;

        case 'CLEAR_BUDGET':
            (async () => {
                await chrome.storage.local.remove('energyBudget');
                await chrome.storage.session.set({ budget: { active: false } });
                batteryHistory.length = 0;
                sendResponse({ success: true });
            })();
            return true;

        case 'SET_PROTECTED':
            (async () => {
                if (!isTabProtected(message.tabId, message.domain)) {
                    protectedTabs.push({
                        tabId: message.tabId, domain: message.domain,
                        title: message.title, protected_since: Date.now()
                    });
                    await chrome.storage.local.set({ protectedTabs });
                }
                sendResponse({ success: true });
            })();
            return true;

        case 'CLEAR_PROTECTED':
            (async () => {
                protectedTabs = protectedTabs.filter(p => p.tabId !== message.tabId && p.domain !== message.domain);
                await chrome.storage.local.set({ protectedTabs });
                sendResponse({ success: true });
            })();
            return true;

        default:
            sendResponse({ error: 'Unknown message type' });
            return false;
    }
});
