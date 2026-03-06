// background.js — Service Worker (ES Module)
// ALL state declarations at top to avoid TDZ errors

import {
    computeEnergyScore, getScoreTier, getTierColor,
    estimateMwh, estimateCO2g, getAdaptiveInterval
} from './energyscore.js';

import {
    initDB, writeTabCycle, writeSessionMeta, pruneOldSessions, writeSuspendEvent
} from './storage.js';

// ============================================================================
// CONFIGURATION
// ============================================================================

const OPENROUTER_KEY = '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';
const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const AI_MODEL = 'arcee-ai/trinity-large-preview:free';

// ============================================================================
// ALL MODULE-LEVEL STATE — declared first, before any function calls
// ============================================================================

let db = null;
let pollTimer = null;
let currentIntervalMs = 5000;
let initialized = false;           // use var-style naming, declared at top
const sessionId = crypto.randomUUID();
const sessionStartTime = Date.now();
let cycleCount = 0;
let totalMwh = 0;
let totalCO2g = 0;
const networkBytes = new Map();
let prevCpuInfo = null;
const sleepingTabs = new Set();

// ============================================================================
// TOP-LEVEL LISTENERS — registered synchronously before any async work
// ============================================================================

// SW lifecycle
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
    event.waitUntil(clients.claim().then(() => {
        if (!initialized) initialize();
    }));
});

// WebRequest — must be top-level sync registration
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

// Alarm — keepalive
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'keepalive') {
        if (!initialized) initialize();
        else if (pollTimer === null) startPolling();
    }
});

// Tab cleanup
chrome.tabs.onRemoved.addListener((tabId) => {
    networkBytes.delete(tabId);
    sleepingTabs.delete(tabId);
});

// ============================================================================
// INITIALIZE — called from top level after all declarations
// ============================================================================

async function initialize() {
    if (initialized) return;
    initialized = true;

    try {
        db = await initDB();
        await pruneOldSessions(db, 7);
    } catch (e) {
        console.warn('TabVolt: DB init failed', e);
    }

    chrome.alarms.clearAll(() => {
        chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
    });

    startPolling();
}

// Boot — safe to call here because ALL state/listeners already declared above
initialize();

// ============================================================================
// POLLING
// ============================================================================

function startPolling() {
    if (pollTimer !== null) return;
    pollTimer = setInterval(runPollCycle, currentIntervalMs);
    runPollCycle(); // run immediately, don't wait for first interval
}

async function runPollCycle() {
    try {
        cycleCount++;
        const now = Date.now();

        const tabs = await chrome.tabs.query({});
        const cpuInfo = await new Promise(r => chrome.system.cpu.getInfo(r));
        const memInfo = await new Promise(r => chrome.system.memory.getInfo(r));
        let batteryInfo = null;
        try { batteryInfo = await chrome.power.getInfo(); } catch (_) { }

        // System CPU delta
        let systemCpuPct = 0;
        if (cpuInfo?.processors && prevCpuInfo) {
            let tot = 0, idl = 0;
            for (let i = 0; i < cpuInfo.processors.length; i++) {
                const c = cpuInfo.processors[i].usage;
                const p = prevCpuInfo.processors[i]?.usage;
                if (p) { tot += c.total - p.total; idl += c.idle - p.idle; }
            }
            systemCpuPct = tot > 0 ? ((tot - idl) / tot) * 100 : 0;
        }
        prevCpuInfo = cpuInfo;
        systemCpuPct = Math.round(systemCpuPct * 10) / 10;

        const memoryPct = memInfo
            ? Math.round(((memInfo.capacity - memInfo.availableCapacity) / memInfo.capacity) * 100 * 10) / 10 : 0;
        const usedRamMB = memInfo
            ? Math.round((memInfo.capacity - memInfo.availableCapacity) / 1048576) : 0;

        const batteryPct = batteryInfo?.level ?? 100;
        const isCharging = batteryInfo?.charging ?? true;

        // Heuristic per-tab CPU weights
        const browserCpuEst = systemCpuPct * 0.6;
        const tabWeights = new Map();
        let totalWeight = 0;
        for (const tab of tabs) {
            if (tab.discarded) { tabWeights.set(tab.id, 0); continue; }
            let w = 1;
            if (tab.active) w += 30;
            if (tab.audible) w += 20;
            if (tab.status === 'loading') w += 15;
            const netKB = (networkBytes.get(tab.id) || 0) / 1024;
            w += Math.min(netKB / 5, 15);
            tabWeights.set(tab.id, w);
            totalWeight += w;
        }

        const pollSecs = currentIntervalMs / 1000;
        const tabPayloads = [];
        const dbRecords = [];

        for (const tab of tabs) {
            const weight = tabWeights.get(tab.id) || 0;
            const tabCpuPct = totalWeight > 0 ? (weight / totalWeight) * browserCpuEst : 0;
            const idleMins = (now - (tab.lastAccessed ?? now)) / 60000;
            const kbThisCycle = (networkBytes.get(tab.id) ?? 0) / 1024;
            networkBytes.delete(tab.id);
            const isBackground = !tab.active;

            let score = 0, mwh = 0, co2 = 0;
            if (!tab.discarded) {
                score = computeEnergyScore(tabCpuPct, idleMins, kbThisCycle, isBackground);
                mwh = estimateMwh(tabCpuPct, pollSecs);
                co2 = estimateCO2g(mwh);
            }

            const tier = getScoreTier(score);
            const tierColor = getTierColor(tier);
            const domain = extractDomain(tab.url);
            totalMwh += mwh;
            totalCO2g += co2;

            let state = 'normal';
            if (tab.discarded) state = 'suspended';
            else if (sleepingTabs.has(tab.id)) state = 'sleeping';

            const browserCpuShare = browserCpuEst > 0
                ? Math.round((tabCpuPct / browserCpuEst) * 100 * 10) / 10 : 0;
            const tabRamSharePct = totalWeight > 0
                ? Math.round((weight / totalWeight) * 100 * 10) / 10 : 0;
            const tabRamEstMB = Math.round(usedRamMB * (weight / (totalWeight || 1)) * 0.6);

            tabPayloads.push({
                tabId: tab.id, title: tab.title || 'Untitled',
                url: tab.url || '', domain, favicon: tab.favIconUrl || '',
                energyscore: Math.round(score),
                cpu_pct: Math.round(tabCpuPct * 10) / 10,
                kb_transferred: Math.round(kbThisCycle * 100) / 100,
                idle_mins: Math.round(idleMins * 100) / 100,
                is_background: isBackground, is_active: tab.active || false,
                mwh_estimated: Math.round(mwh * 10000) / 10000,
                co2_grams: Math.round(co2 * 10000) / 10000,
                tier, tierColor, state,
                audible: tab.audible || false,
                pinned: tab.pinned || false,
                browser_cpu_share: browserCpuShare,
                browser_ram_share: tabRamSharePct,
                memory_mb: tabRamEstMB
            });

            dbRecords.push({
                session_id: sessionId, timestamp: now, tab_id: tab.id,
                domain, title: tab.title || 'Untitled', url: tab.url || '',
                energyscore: Math.round(score), cpu_pct: Math.round(tabCpuPct * 10) / 10,
                kb_transferred: Math.round(kbThisCycle * 100) / 100,
                idle_mins: Math.round(idleMins * 100) / 100, is_background: isBackground,
                mwh_estimated: Math.round(mwh * 10000) / 10000,
                co2_grams: Math.round(co2 * 10000) / 10000
            });
        }

        const durationMins = (now - sessionStartTime) / 60000;
        try {
            await chrome.storage.session.set({
                tabs: tabPayloads,
                system: { cpu_pct: systemCpuPct, memory_pct: memoryPct, battery_pct: batteryPct, is_charging: isCharging },
                browser_totals: { cpu_pct: Math.round(browserCpuEst * 10) / 10, ram_mb: usedRamMB },
                session: {
                    session_id: sessionId, start_time: sessionStartTime,
                    duration_mins: Math.round(durationMins * 10) / 10,
                    total_mwh: Math.round(totalMwh * 1000) / 1000,
                    total_co2_grams: Math.round(totalCO2g * 1000) / 1000
                },
                companion: { online: false },
                poll: { interval_ms: currentIntervalMs, cycle_count: cycleCount, last_updated: now }
            });
        } catch (_) { }

        // PHASE 2 — Heatmap rolling buffer (30 cycles per tab)
        try {
            const stored = await chrome.storage.session.get('heatmap_buffer');
            const heatmap = stored.heatmap_buffer || {};
            const currentTabIds = new Set();
            for (let idx = 0; idx < tabPayloads.length; idx++) {
                const t = tabPayloads[idx];
                currentTabIds.add(String(t.tabId));
                const key = String(t.tabId);
                if (!heatmap[key]) {
                    heatmap[key] = { title: t.title, favicon: t.favicon, url: t.url, order: idx, scores: [] };
                }
                heatmap[key].title = t.title;
                heatmap[key].favicon = t.favicon;
                heatmap[key].url = t.url;
                heatmap[key].order = idx;
                heatmap[key].scores.push(t.energyscore);
                if (heatmap[key].scores.length > 30) {
                    heatmap[key].scores.shift();
                }
            }
            // Remove tabs that no longer exist
            for (const key of Object.keys(heatmap)) {
                if (!currentTabIds.has(key)) delete heatmap[key];
            }
            await chrome.storage.session.set({ heatmap_buffer: heatmap });
        } catch (_) { }
        // END PHASE 2

        try {
            await writeTabCycle(db, dbRecords);
            await writeSessionMeta(db, {
                session_id: sessionId, start_time: sessionStartTime, end_time: now,
                total_tabs_monitored: tabs.length, total_mwh: totalMwh, total_co2_grams: totalCO2g
            });
        } catch (_) { }

        // ---- AUTO-SUSPEND: discard idle background tabs (like Edge sleeping tabs) ----
        const AUTO_SUSPEND_IDLE_MINS = 5;
        try {
            const autoSuspendCandidates = tabPayloads.filter(t =>
                t.is_background &&
                t.state === 'normal' &&
                !t.audible &&
                !t.pinned &&
                (t.idle_mins || 0) >= AUTO_SUSPEND_IDLE_MINS
            );

            for (const t of autoSuspendCandidates) {
                try {
                    // Log the suspend event before discarding
                    await logSuspendEvent(t.tabId, 'auto');
                    await chrome.tabs.discard(t.tabId);
                    sleepingTabs.delete(t.tabId);
                } catch (_) { }
            }
        } catch (_) { }

        const newInterval = getAdaptiveInterval(batteryPct, systemCpuPct, isCharging);
        if (newInterval !== currentIntervalMs) {
            clearInterval(pollTimer); pollTimer = null;
            currentIntervalMs = newInterval;
            startPolling();
        }
    } catch (err) {
        console.error('TabVolt: Poll error:', err);
    }
}

function extractDomain(url) {
    try { return new URL(url).hostname; } catch (_) { return ''; }
}

// ============================================================================
// SLEEP / WAKE
// ============================================================================

async function sleepTab(tabId) {
    try {
        const info = await chrome.tabs.get(tabId);
        if (info.discarded) return { success: false, error: 'Tab is suspended' };
    } catch (e) { return { success: false, error: e.message }; }

    try {
        await chrome.scripting.executeScript({
            target: { tabId },
            func: () => {
                if (document.getElementById('tabvolt-sleep')) return;
                const s = document.createElement('style');
                s.id = 'tabvolt-sleep';
                s.textContent = '*, *::before, *::after { animation-play-state: paused !important; transition: none !important; }';
                document.head.appendChild(s);
                window.__tabvolt_raf = window.requestAnimationFrame;
                window.requestAnimationFrame = () => 0;
            }
        });
        sleepingTabs.add(tabId);
        return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
}

async function wakeTab(tabId) {
    try {
        await chrome.scripting.executeScript({
            target: { tabId },
            func: () => {
                const s = document.getElementById('tabvolt-sleep');
                if (s) s.remove();
                if (window.__tabvolt_raf) { window.requestAnimationFrame = window.__tabvolt_raf; delete window.__tabvolt_raf; }
            }
        });
        sleepingTabs.delete(tabId);
        return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
}

// ============================================================================
// AI — OpenRouter
// Structural approach: ONLY pass suspendable candidates to the AI.
// Active tab + audible tabs are excluded from the suggestion list entirely.
// AI cannot hallucinate tabs that are not in its input.
// ============================================================================

async function getAISuggestion() {
    const state = await chrome.storage.session.get(null);
    const allTabs = state.tabs || [];
    const sys = state.system || {};
    const sess = state.session || {};

    // Split tabs into context groups
    const activeTabs = allTabs.filter(t => t.is_active);
    const audioTabs = allTabs.filter(t => t.audible && !t.is_active);
    const candidates = allTabs.filter(t =>
        !t.is_active && !t.audible && !t.pinned && t.state === 'normal'
    ).sort((a, b) => b.energyscore - a.energyscore).slice(0, 6);
    const suspendedTabs = allTabs.filter(t => t.state === 'suspended');

    // If nothing actionable, tell AI directly
    if (candidates.length === 0) {
        const contextTabs = [...activeTabs, ...audioTabs].map(t => `"${t.title}"`).join(', ');
        return suspendedTabs.length > 0
            ? `All background tabs are already suspended. Currently active: ${contextTabs || 'no other tabs'}. Your browser is well-optimized right now.`
            : `Only active or audio-playing tabs remain open: ${contextTabs}. These cannot be suspended as they are in use. No action needed.`;
    }

    const activeContext = activeTabs.map(t => `"${t.title}" (you are using this)`).join(', ');
    const audioContext = audioTabs.map(t => `"${t.title}" (playing audio — do not disturb)`).join(', ');
    const candidateList = candidates.map((t, i) =>
        `${i + 1}. "${t.title}" | score:${t.energyscore} | cpu:${t.cpu_pct}% | idle:${Math.round(t.idle_mins)}m`
    ).join('\n');

    const systemPrompt = `You are a browser energy optimizer for TabVolt.
STRICT RULES — violations will confuse the user:
1. NEVER suggest action on tabs marked "you are using this" or "playing audio".
2. ONLY suggest suspending tabs from the CANDIDATES LIST below.
3. Do not mention any tab not in the candidates list or context lists.
4. Keep response to 2 sentences max. Name the specific tab. End with one action verb sentence.`;

    const userPrompt = `Battery: ${sys.battery_pct ?? '--'}% (${sys.is_charging ? 'charging' : 'on battery'}) | CPU: ${sys.cpu_pct ?? '--'}%
Session: ${Math.round(sess.duration_mins || 0)} min

CURRENTLY IN USE (do NOT touch):
${activeContext || 'none'}
${audioContext ? `\nAUDIO PLAYING (do NOT touch):\n${audioContext}` : ''}

CANDIDATES you may suggest suspending (ranked by energy waste):
${candidateList}

Which single candidate should be suspended first and why?`;

    try {
        const res = await fetch(OPENROUTER_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${OPENROUTER_KEY}`,
                'HTTP-Referer': 'https://tabvolt.ext',
                'X-Title': 'TabVolt'
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
            return res.status === 401
                ? 'AI error: Invalid API key. Check OPENROUTER_KEY in background.js.'
                : `AI error ${res.status}. Try again.`;
        }
        const data = await res.json();
        return data?.choices?.[0]?.message?.content?.trim() || 'No suggestion available.';
    } catch (e) {
        console.error('TabVolt AI error:', e.message);
        return 'Unable to reach AI. Check your connection.';
    }
}

// ============================================================================
// SUSPEND EVENT LOGGER
// ============================================================================

async function logSuspendEvent(tabId, trigger) {
    try {
        const state = await chrome.storage.session.get(['tabs']);
        const tabData = (state.tabs || []).find(t => t.tabId === tabId);
        if (!tabData || !db) return;

        let domain = '';
        try { domain = new URL(tabData.url || '').hostname; } catch (_) { }

        await writeSuspendEvent(db, {
            session_id: sessionId,
            timestamp: Date.now(),
            tab_id: tabId,
            domain: domain,
            title: tabData.title || 'Untitled',
            pre_suspend_score: tabData.energyscore || 0,
            pre_suspend_cpu: tabData.cpu_pct || 0,
            pre_suspend_mwh_rate: tabData.mwh_estimated || 0,
            trigger: trigger
        });
    } catch (e) {
        console.warn('[TabVolt] Failed to log suspend event:', e);
    }
}

// ============================================================================
// MESSAGE HANDLER
// ============================================================================

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message.type) {
        case 'SUSPEND_TAB':
            (async () => {
                try {
                    await logSuspendEvent(message.tabId, 'manual');
                    await chrome.tabs.discard(message.tabId);
                    sleepingTabs.delete(message.tabId);
                    sendResponse({ success: true });
                } catch (e) {
                    sendResponse({ success: false, error: e.message });
                }
            })();
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
                const state = await chrome.storage.session.get(null);
                const candidates = (state.tabs || [])
                    .filter(t => t.is_background && t.state === 'normal' && !t.audible && !t.pinned)
                    .sort((a, b) => b.energyscore - a.energyscore);
                let suspended = 0;
                for (const t of candidates) {
                    if (suspended >= n) break;
                    try {
                        await logSuspendEvent(t.tabId, 'bulk');
                        await chrome.tabs.discard(t.tabId);
                        sleepingTabs.delete(t.tabId);
                        suspended++;
                    } catch (_) { }
                }
                sendResponse({ success: true, suspended });
            })();
            return true;
        }

        case 'SUSPEND_SPECIFIC':
            (async () => {
                try {
                    await logSuspendEvent(message.tabId, 'ai');
                    await chrome.tabs.discard(message.tabId);
                    sleepingTabs.delete(message.tabId);
                    sendResponse({ success: true });
                } catch (e) {
                    sendResponse({ success: false, error: e.message });
                }
            })();
            return true;

        case 'GET_STATE':
            chrome.storage.session.get(null, (data) => sendResponse(data || {}));
            return true;

        case 'GET_AI_SUGGESTION':
            getAISuggestion().then(suggestion => sendResponse({ suggestion }));
            return true;

        default:
            sendResponse({ error: 'Unknown message type' });
            return false;
    }
});
