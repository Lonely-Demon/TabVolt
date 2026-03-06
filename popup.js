// popup.js — ES Module UI

// ============================================================================
// HELPERS
// ============================================================================

function getScoreTier(score) {
    if (score > 70) return 'high';
    if (score >= 30) return 'mid';
    return 'low';
}
function getTierColor(tier) {
    return tier === 'high' ? '#C0392B' : tier === 'mid' ? '#F39C12' : '#27AE60';
}

const DEFAULT_FAVICON = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="%23666" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>'
);

const ICON_SLEEP = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>`;
const ICON_SUSPEND = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`;
const ICON_WAKE = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
const ICON_AUDIO = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07"/></svg>`;

// ============================================================================
// DOM REFS
// ============================================================================

const metricCpu = document.getElementById('metric-cpu');
const metricRam = document.getElementById('metric-ram');
const metricBattery = document.getElementById('metric-battery');
const tabListEl = document.getElementById('tab-list');
const companionBadge = document.getElementById('companion-badge');
const enhancedToggle = document.getElementById('enhanced-toggle');
const btnSuspendTop = document.getElementById('btn-suspend-top');
const btnAiSuggest = document.getElementById('btn-ai-suggest');
const aiPanel = document.getElementById('ai-panel');
const aiText = document.getElementById('ai-text');
const btnActNow = document.getElementById('btn-act-now');
const footerMwh = document.getElementById('footer-mwh');
const footerCo2 = document.getElementById('footer-co2');
const footerRam = document.getElementById('footer-ram');

// Portal tooltip — single element, lives OUTSIDE all tab rows
const tooltipPanel = document.getElementById('tab-tooltip-panel');
const ttTitle = document.getElementById('tt-title');
const ttCpu = document.getElementById('tt-cpu');
const ttRam = document.getElementById('tt-ram');
const ttNet = document.getElementById('tt-net');
const ttIdle = document.getElementById('tt-idle');

let lastAiTargetTabId = null;

// PHASE 2 — DOM refs
const heatmapCanvas = document.getElementById('heatmap-canvas');
const heatmapCtx = heatmapCanvas ? heatmapCanvas.getContext('2d') : null;
const heatmapTabCount = document.getElementById('heatmap-tab-count');
const companionPanel = document.getElementById('companion-panel');
const compTemp = document.getElementById('comp-temp');
const compIgpu = document.getElementById('comp-igpu');
const compSource = document.getElementById('comp-source');
const btnHistory = document.getElementById('btn-history');

// ============================================================================
// PORTAL TOOLTIP — 600ms delay, single shared element, never clips
// ============================================================================

let hoverTimer = null;
let activeRow = null;

// Tab data map for tooltip population (tabId → tab payload)
const tabDataMap = new Map();

function showTooltip(tabId) {
    const t = tabDataMap.get(tabId);
    if (!t || t.state === 'suspended') return;
    ttTitle.textContent = t.title;
    ttCpu.textContent = `${t.cpu_pct}%`;
    ttRam.textContent = `~${t.memory_mb || 0} MB`;
    ttNet.textContent = formatKB(t.kb_transferred);
    ttIdle.textContent = formatIdle(t.idle_mins);
    tooltipPanel.style.display = 'block';
}

function hideTooltip() {
    clearTimeout(hoverTimer);
    hoverTimer = null;
    tooltipPanel.style.display = 'none';
    activeRow = null;
}

function attachHover(rowEl, tabId) {
    rowEl.addEventListener('mouseenter', () => {
        // Cancel any pending hide from a previous row
        clearTimeout(hoverTimer);
        activeRow = rowEl;
        hoverTimer = setTimeout(() => showTooltip(tabId), 600);
    });
    rowEl.addEventListener('mouseleave', () => {
        clearTimeout(hoverTimer);
        hoverTimer = null;
        // Small grace period — if user enters another row, that row's mouseenter takes over
        // If they leave entirely (mouseout to body), hide after brief pause
        hoverTimer = setTimeout(hideTooltip, 80);
    });
}

// ============================================================================
// RENDER
// ============================================================================

function renderSystemMetrics(system) {
    if (!system) return;

    const iconCpu = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="4" width="16" height="16" rx="2" ry="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/></svg>`;
    const iconRam = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="6" width="20" height="12" rx="2" ry="2"/><line x1="6" y1="6" x2="6" y2="18"/><line x1="10" y1="6" x2="10" y2="18"/><line x1="14" y1="6" x2="14" y2="18"/><line x1="18" y1="6" x2="18" y2="18"/></svg>`;
    const iconBattery = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--color-ok)"><rect x="1" y="6" width="18" height="12" rx="2" ry="2"/><line x1="23" y1="13" x2="23" y2="11"/></svg>`;
    const iconCharge = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--color-warn)"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`;

    metricCpu.innerHTML = `${iconCpu} CPU ${system.cpu_pct}%`;
    metricRam.innerHTML = `${iconRam} RAM ${system.memory_pct}%`;
    metricBattery.innerHTML = `${system.is_charging ? iconCharge : iconBattery} ${system.battery_pct}%`;
}

function renderTabList(tabs) {
    tabDataMap.clear();

    if (!tabs || tabs.length === 0) {
        tabListEl.innerHTML = '<p class="empty-state">Waiting for data…</p>';
        return;
    }

    // Tabs stay in browser order — no sort
    const html = tabs.map(t => {
        tabDataMap.set(t.tabId, t);

        const tier = getScoreTier(t.energyscore);
        const color = getTierColor(tier);
        const title = t.title.length > 28 ? t.title.slice(0, 28) + '…' : t.title;
        const favicon = t.favicon || DEFAULT_FAVICON;
        const state = t.state || 'normal';

        // PHASE 3 — protected styling
        const isProtected = t.is_protected || false;
        const rowClass = isProtected ? (state === 'suspended' ? 'tab-row suspended protected' : 'tab-row protected')
            : state === 'suspended' ? 'tab-row suspended'
                : state === 'sleeping' ? 'tab-row sleeping' : 'tab-row';

        let stateBadge = '';
        if (state === 'suspended') stateBadge = '<span class="tab-state-badge state-suspended">Suspended</span>';
        else if (state === 'sleeping') stateBadge = '<span class="tab-state-badge state-sleeping">Sleeping</span>';
        else if (t.audible) stateBadge = `<span class="tab-state-badge state-audible">${ICON_AUDIO}</span>`;
        else if (isProtected) stateBadge = '<span class="tab-state-badge" style="color:var(--color-accent,#E86A1A);font-size:9px;">Protected</span>';

        // PHASE 3 — preemptive flag badge
        const preemptiveBadge = (t.preemptive_flag && !isProtected)
            ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--color-warn,#F39C12)" stroke-width="2" style="margin-right:2px;flex-shrink:0;" title="Historically ignored — likely safe to suspend"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`
            : '';

        // PHASE 3 — score badge dashed border for preemptive
        const scoreBorderStyle = (t.preemptive_flag && !isProtected)
            ? `background:${color};border:1px dashed var(--color-warn,#F39C12)`
            : `background:${color}`;

        // PHASE 3 — shield button + actions
        const shieldIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1L3 5v6c0 5.5 3.8 10.7 9 12 5.2-1.3 9-6.5 9-12V5l-9-4z"/></svg>`;
        const shieldBtn = (!t.audible && state !== 'suspended')
            ? `<button class="tab-btn btn-shield" data-tab-id="${t.tabId}" data-domain="${escapeAttr(t.domain || '')}" data-title="${escapeAttr(t.title)}" title="${isProtected ? 'Remove protection' : 'Protect this tab'}" style="color:${isProtected ? 'var(--color-accent,#E86A1A)' : 'var(--text-muted,#999)'}">${shieldIcon}</button>`
            : '';

        let actions = '';
        if (isProtected) {
            actions = `<div class="tab-actions">${shieldBtn}</div>`;
        } else if (state === 'normal') {
            actions = `<div class="tab-actions">
        ${shieldBtn}
        <button class="tab-btn btn-sleep" data-tab-id="${t.tabId}">${ICON_SLEEP}</button>
        ${t.is_background ? `<button class="tab-btn btn-suspend" data-tab-id="${t.tabId}">${ICON_SUSPEND}</button>` : ''}
      </div>`;
        } else if (state === 'sleeping') {
            actions = `<div class="tab-actions">
        ${shieldBtn}
        <button class="tab-btn btn-wake" data-tab-id="${t.tabId}">${ICON_WAKE}</button>
      </div>`;
        }

        return `<div class="${rowClass}" data-tab-id="${t.tabId}" ${isProtected ? 'style="border-left:2px solid var(--color-accent,#E86A1A)"' : ''}>
      <img class="tab-favicon" src="${escapeAttr(favicon)}" width="16" height="16" onerror="this.src='${DEFAULT_FAVICON}'">
      ${preemptiveBadge}
      <span class="tab-title" title="${escapeAttr(t.title)}">${escapeHtml(title)}</span>
      ${stateBadge}
      <span class="score-badge" style="${scoreBorderStyle}">${Math.round(t.energyscore)}</span>
      ${actions}
    </div>`;
    }).join('');

    tabListEl.innerHTML = html;
    attachTabActions();

    // Attach portal tooltip hover to every row
    tabListEl.querySelectorAll('.tab-row').forEach(row => {
        const tabId = parseInt(row.dataset.tabId);
        attachHover(row, tabId);
    });
}

function attachTabActions() {
    tabListEl.querySelectorAll('.btn-suspend').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const tabId = parseInt(e.currentTarget.dataset.tabId);
            chrome.runtime.sendMessage({ type: 'SUSPEND_TAB', tabId });
            const row = e.currentTarget.closest('.tab-row');
            row.classList.remove('sleeping'); row.classList.add('suspended');
            row.querySelector('.tab-actions')?.remove();
            hideTooltip();
        });
    });
    tabListEl.querySelectorAll('.btn-sleep').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const tabId = parseInt(e.currentTarget.dataset.tabId);
            chrome.runtime.sendMessage({ type: 'SLEEP_TAB', tabId });
            e.currentTarget.closest('.tab-row').classList.add('sleeping');
        });
    });
    tabListEl.querySelectorAll('.btn-wake').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const tabId = parseInt(e.currentTarget.dataset.tabId);
            chrome.runtime.sendMessage({ type: 'WAKE_TAB', tabId });
            e.currentTarget.closest('.tab-row').classList.remove('sleeping');
        });
    });
    // PHASE 3 — Shield button click handler
    tabListEl.querySelectorAll('.btn-shield').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const tabId = parseInt(e.currentTarget.dataset.tabId);
            const domain = e.currentTarget.dataset.domain || '';
            const title = e.currentTarget.dataset.title || '';
            const t = tabDataMap.get(tabId);
            const isProtected = t?.is_protected || false;
            const msgType = isProtected ? 'CLEAR_PROTECTED' : 'SET_PROTECTED';
            chrome.runtime.sendMessage({ type: msgType, tabId, domain, title }, () => {
                loadAndRender(); // refresh to reflect new state
            });
        });
    });
}

function renderFooter(session, poll) {
    if (session) {
        footerMwh.textContent = `Session: ${(session.total_mwh || 0).toFixed(1)} mWh`;
        // PHASE 3 — contextual CO₂ display
        footerCo2.textContent = formatCO2(session.total_co2_grams || 0);
    }
    if (poll?.last_updated) {
        const ago = Math.round((Date.now() - poll.last_updated) / 1000);
        footerRam.textContent = `Updated: ${ago}s ago`;
    }
}

// PHASE 3 — Contextual CO₂ formatting
function formatCO2(grams) {
    if (grams < 1) return `${grams.toFixed(2)}g CO₂`;
    const km = (grams / 1000 / 0.13);
    if (km < 0.01) return `${grams.toFixed(1)}g CO₂`;
    return `${grams.toFixed(1)}g CO₂ · ${km.toFixed(3)}km 🚗`;
}

// ============================================================================
// FORMATTING
// ============================================================================

function formatKB(kb) {
    if (!kb) return '0 KB';
    return kb >= 1024 ? (kb / 1024).toFixed(1) + ' MB' : Math.round(kb) + ' KB';
}
function formatIdle(mins) {
    if (!mins) return '<1m';
    if (mins >= 60) return Math.floor(mins / 60) + 'h ' + Math.round(mins % 60) + 'm';
    if (mins >= 1) return Math.round(mins) + 'm';
    return '<1m';
}
function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function escapeAttr(s) {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ============================================================================
// DATA REFRESH
// ============================================================================

async function loadAndRender() {
    const data = await chrome.storage.session.get(null);
    if (!data?.tabs) {
        tabListEl.innerHTML = '<p class="empty-state">Waiting for data…</p>';
        hideTooltip();
        return;
    }

    // Cache top suspendable tab for Act Now
    const suspendable = data.tabs
        .filter(t => t.is_background && t.state === 'normal' && !t.audible && !t.pinned)
        .sort((a, b) => b.energyscore - a.energyscore);
    lastAiTargetTabId = suspendable[0]?.tabId ?? null;

    renderSystemMetrics(data.system);
    renderTabList(data.tabs);
    renderHeatmap(data.heatmap_buffer); // PHASE 2
    renderFooter(data.session, data.poll);

    // PHASE 3 — Budget status bar
    const budgetStatus = document.getElementById('budget-status');
    const budgetBar = document.getElementById('budget-bar');
    const budgetLabel = document.getElementById('budget-label');
    const btnSetBudget = document.getElementById('btn-set-budget');
    const btnClearBudget = document.getElementById('btn-clear-budget');
    if (data.budget?.active) {
        budgetStatus.style.display = 'block';
        if (btnSetBudget) btnSetBudget.style.display = 'none';
        if (btnClearBudget) btnClearBudget.style.display = 'block';
        const batt = data.system?.battery_pct || 100;
        const target = data.budget.targetPct || 20;
        const pct = Math.max(0, Math.min(100, ((batt - target) / (100 - target)) * 100));
        budgetBar.style.width = pct + '%';
        if (pct > 40) budgetBar.style.background = 'var(--color-ok,#27AE60)';
        else if (pct > 15) budgetBar.style.background = 'var(--color-warn,#F39C12)';
        else budgetBar.style.background = 'var(--color-crit,#C0392B)';
        budgetLabel.textContent = `${data.budget.onTrack ? '✅ On track' : '⚠️ Over budget'} — ${data.budget.remainingMins || 0}m remaining — target: ${target}%`;
        if (data.budget.lastAction) budgetLabel.textContent += ` — ${data.budget.lastAction}`;
    } else {
        if (budgetStatus) budgetStatus.style.display = 'none';
        if (btnSetBudget) btnSetBudget.style.display = 'block';
        if (btnClearBudget) btnClearBudget.style.display = 'none';
    }
}

// ============================================================================
// COMPANION CHECK
// ============================================================================

async function checkCompanion() {
    try {
        const res = await fetch('http://localhost:9001/metrics', { signal: AbortSignal.timeout(2000) });
        if (res.ok) {
            companionBadge.textContent = 'ONLINE';
            companionBadge.className = 'badge-online';
            enhancedToggle.checked = true;
            // Hide setup instructions if showing
            const setupEl = document.getElementById('companion-setup');
            if (setupEl) setupEl.style.display = 'none';

            // PHASE 2 — populate companion panel
            const metrics = await res.json();
            if (companionPanel) {
                companionPanel.style.display = 'flex';
                const tempIcon = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 14.76V3.5a2.5 2.5 0 00-5 0v11.26a4.5 4.5 0 105 0z"/></svg>`;
                const gpuIcon = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`;
                compTemp.innerHTML = metrics.cpu_temp_c === -1
                    ? `${tempIcon} Temp: N/A`
                    : `${tempIcon} Temp: ${metrics.cpu_temp_c.toFixed(1)}°C`;
                compIgpu.innerHTML = metrics.igpu_pct === -1
                    ? `${gpuIcon} iGPU: N/A`
                    : `${gpuIcon} iGPU: ${metrics.igpu_pct.toFixed(1)}%`;
                compSource.textContent = metrics.temp_source === 'acpi_thermal_zone' ? '(ACPI)' : '(unavailable)';
            }
        }
    } catch (_) {
        companionBadge.textContent = 'OFFLINE';
        companionBadge.className = 'badge-offline';
        enhancedToggle.checked = false;
        if (companionPanel) companionPanel.style.display = 'none';
    }
}

// ============================================================================
// EVENT LISTENERS
// ============================================================================

btnSuspendTop.addEventListener('click', () => {
    btnSuspendTop.disabled = true;
    btnSuspendTop.textContent = 'Suspending…';
    chrome.runtime.sendMessage({ type: 'SUSPEND_TOP_N', n: 3 }, (res) => {
        btnSuspendTop.textContent = `✓ ${res?.suspended || 0} suspended`;
        setTimeout(() => {
            loadAndRender();
            btnSuspendTop.textContent = 'Suspend Idle Tabs';
            btnSuspendTop.disabled = false;
        }, 1500);
    });
});

btnAiSuggest.addEventListener('click', () => {
    aiPanel.style.display = 'block';
    aiText.textContent = 'Generating suggestion…';
    aiText.style.opacity = '0.6';
    btnActNow.style.display = 'none'; // hide until response and target confirmed
    btnAiSuggest.disabled = true;
    chrome.runtime.sendMessage({ type: 'GET_AI_SUGGESTION' }, (response) => {
        aiText.textContent = response?.suggestion || 'Unable to get suggestion.';
        aiText.style.opacity = '1';
        btnAiSuggest.disabled = false;
        // Only show Act Now if there is actually a suspendable target available
        btnActNow.style.display = lastAiTargetTabId !== null ? 'inline-block' : 'none';
    });
});

btnActNow.addEventListener('click', () => {
    if (lastAiTargetTabId !== null) {
        chrome.runtime.sendMessage({ type: 'SUSPEND_SPECIFIC', tabId: lastAiTargetTabId });
        lastAiTargetTabId = null;
    }
    aiPanel.style.display = 'none';
    setTimeout(loadAndRender, 800);
});

// Hide tooltip when mouse leaves the tab list container entirely
document.getElementById('tab-list-container').addEventListener('mouseleave', hideTooltip);

// PHASE 2 — History button
if (btnHistory) {
    btnHistory.addEventListener('click', () => {
        chrome.tabs.create({ url: 'history.html' });
    });
}

// PHASE 2 — Re-check companion on toggle change
const companionSetup = document.getElementById('companion-setup');
enhancedToggle.addEventListener('change', async () => {
    if (enhancedToggle.checked) {
        // User wants to enable — try connecting
        try {
            const res = await fetch('http://localhost:9001/metrics', { signal: AbortSignal.timeout(2000) });
            if (res.ok) {
                // Online — hide setup, show panel
                if (companionSetup) companionSetup.style.display = 'none';
                checkCompanion();
            } else {
                throw new Error('not ok');
            }
        } catch (_) {
            // Offline — show setup instructions
            enhancedToggle.checked = false;
            if (companionSetup) companionSetup.style.display = 'block';
        }
    } else {
        // User disabled — hide panels
        if (companionSetup) companionSetup.style.display = 'none';
        if (companionPanel) companionPanel.style.display = 'none';
        companionBadge.textContent = 'OFFLINE';
        companionBadge.className = 'badge-offline';
    }
});

// ============================================================================
// PHASE 2 — HEATMAP RENDERER
// ============================================================================

function scoreToColor(score) {
    if (score >= 70) return '#C0392B';
    if (score >= 30) {
        // 30–70 → interpolate #F39C12 to #C0392B
        const t = (score - 30) / 40;
        const r = Math.round(243 + (192 - 243) * t);
        const g = Math.round(156 + (57 - 156) * t);
        const b = Math.round(18 + (43 - 18) * t);
        return `rgb(${r},${g},${b})`;
    }
    // 0–30 → interpolate #27AE60 to #F39C12
    const t = score / 30;
    const r = Math.round(39 + (243 - 39) * t);
    const g = Math.round(174 + (156 - 174) * t);
    const b = Math.round(96 + (18 - 96) * t);
    return `rgb(${r},${g},${b})`;
}

const faviconCache = new Map();

function renderHeatmap(buffer) {
    if (!heatmapCtx || !buffer) return;
    const canvas = heatmapCanvas;
    const ctx = heatmapCtx;
    const dpr = window.devicePixelRatio || 1;

    // Get entries sorted by tab order (same as tab list above), capped at 10
    const entries = Object.entries(buffer)
        .map(([id, data]) => ({ id, title: data.title, favicon: data.favicon, url: data.url, order: data.order ?? 999, scores: data.scores }))
        .filter(e => e.scores.length > 0)
        .sort((a, b) => a.order - b.order)
        .slice(0, 10);

    if (entries.length === 0) {
        canvas.width = 380 * dpr; canvas.height = 30 * dpr;
        canvas.style.width = '380px'; canvas.style.height = '30px';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = '#666';
        ctx.font = '11px -apple-system, sans-serif';
        ctx.fillText('Waiting for data…', 140, 18);
        return;
    }

    const cellW = 11, cellH = 14, gapX = 1, gapY = 3;
    const cols = 30;
    const labelW = 24;
    const totalH = entries.length * (cellH + gapY) - gapY;
    const cssW = labelW + cols * (cellW + gapX);
    const cssH = Math.max(totalH + 4, 30);

    // HiDPI: render at native resolution, display at CSS size
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, cssW, cssH);

    if (heatmapTabCount) {
        heatmapTabCount.textContent = `${entries.length} tab${entries.length !== 1 ? 's' : ''}`;
    }

    entries.forEach((entry, rowIdx) => {
        const y = rowIdx * (cellH + gapY);
        const iconSize = 14;
        const iconY = y + (cellH - iconSize) / 2;

        // Resolve favicon: prefer Chrome's _favicon API (works for ALL URLs),
        // fall back to direct favicon URL, then letter circle
        const tabUrl = entry.url || '';
        const faviconApiUrl = tabUrl
            ? `${chrome.runtime.getURL('_favicon/')}?pageUrl=${encodeURIComponent(tabUrl)}&size=64`
            : '';
        const directUrl = entry.favicon || '';
        // Try _favicon API first, then direct, pick whichever is available
        const iconSrc = faviconApiUrl || directUrl;

        if (iconSrc) {
            if (faviconCache.has(iconSrc)) {
                const img = faviconCache.get(iconSrc);
                if (img.complete && img.naturalHeight !== 0) {
                    ctx.drawImage(img, (labelW - iconSize) / 2, iconY, iconSize, iconSize);
                } else {
                    drawLetterCircle(ctx, entry, y, labelW, cellH);
                }
            } else {
                drawLetterCircle(ctx, entry, y, labelW, cellH);
                const img = new Image();
                img.onload = () => {
                    faviconCache.set(iconSrc, img);
                    if (window.__heatmapReRenderTimer) clearTimeout(window.__heatmapReRenderTimer);
                    window.__heatmapReRenderTimer = setTimeout(() => renderHeatmap(buffer), 50);
                };
                img.onerror = () => faviconCache.set(iconSrc, new Image());
                img.src = iconSrc;
            }
        } else {
            drawLetterCircle(ctx, entry, y, labelW, cellH);
        }

        // Draw cells: pad with empty cells on the left if fewer than 30
        for (let col = 0; col < cols; col++) {
            const dataIdx = col - (cols - entry.scores.length);
            const x = labelW + col * (cellW + gapX);
            if (dataIdx < 0 || dataIdx >= entry.scores.length) {
                ctx.fillStyle = '#1A1A2E'; // empty cell (surface color)
            } else {
                ctx.fillStyle = scoreToColor(entry.scores[dataIdx]);
            }
            ctx.fillRect(x, y, cellW, cellH);
        }
    });
}

// ============================================================================
// STARTUP
// ============================================================================

function drawLetterCircle(ctx, entry, y, labelW, cellH) {
    const cx = labelW / 2;
    const cy = y + cellH / 2;
    const r = 6;
    // Background circle
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = '#333';
    ctx.fill();
    // Letter
    const letter = (entry.title || '?').charAt(0).toUpperCase();
    ctx.fillStyle = '#E86A1A';
    ctx.font = 'bold 8px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(letter, cx, cy);
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
}

document.addEventListener('DOMContentLoaded', () => {
    loadAndRender();
    setInterval(loadAndRender, 3000);
    checkCompanion();

    // PHASE 3 — Budget section collapse/expand
    const budgetHeader = document.getElementById('budget-header');
    const budgetControls = document.getElementById('budget-controls');
    const budgetArrow = document.getElementById('budget-toggle-arrow');
    if (budgetHeader) {
        budgetHeader.addEventListener('click', () => {
            const show = budgetControls.style.display === 'none';
            budgetControls.style.display = show ? 'block' : 'none';
            budgetArrow.innerHTML = show ? '&#9650;' : '&#9660;';
        });
    }

    // PHASE 3 — Set budget
    const btnSetBudget = document.getElementById('btn-set-budget');
    if (btnSetBudget) {
        btnSetBudget.addEventListener('click', () => {
            const pctInput = document.getElementById('budget-target-pct');
            const timeInput = document.getElementById('budget-target-time');
            const targetPct = parseInt(pctInput?.value);
            const targetTimeStr = timeInput?.value;
            if (!targetPct || targetPct < 10 || targetPct > 90 || !targetTimeStr) return;
            // Build today's date with the target time
            const [h, m] = targetTimeStr.split(':').map(Number);
            const targetDate = new Date();
            targetDate.setHours(h, m, 0, 0);
            if (targetDate.getTime() <= Date.now()) targetDate.setDate(targetDate.getDate() + 1);
            chrome.runtime.sendMessage({ type: 'SET_BUDGET', targetPct, targetTime: targetDate.toISOString() });
            pctInput.value = ''; timeInput.value = '';
        });
    }

    // PHASE 3 — Clear budget
    const btnClearBudget = document.getElementById('btn-clear-budget');
    if (btnClearBudget) {
        btnClearBudget.addEventListener('click', () => {
            chrome.runtime.sendMessage({ type: 'CLEAR_BUDGET' });
        });
    }

    // AI Settings — collapse/expand + key management
    const aiHeader = document.getElementById('ai-settings-header');
    const aiBody = document.getElementById('ai-settings-body');
    const aiKeyStatus = document.getElementById('ai-key-status');
    if (aiHeader && aiBody) {
        // Show status on load
        chrome.storage.local.get('groqApiKey', (data) => {
            aiKeyStatus.textContent = data.groqApiKey ? '✓ Key set' : '⚠ No key';
            aiKeyStatus.style.color = data.groqApiKey ? 'var(--color-ok,#27AE60)' : 'var(--color-warn,#F39C12)';
        });
        aiHeader.addEventListener('click', () => {
            aiBody.style.display = aiBody.style.display === 'none' ? 'block' : 'none';
        });
    }
    const btnSaveKey = document.getElementById('btn-save-key');
    if (btnSaveKey) {
        btnSaveKey.addEventListener('click', () => {
            const keyInput = document.getElementById('groq-key-input');
            const key = keyInput?.value?.trim();
            if (!key) return;
            chrome.storage.local.set({ groqApiKey: key }, () => {
                keyInput.value = '';
                if (aiKeyStatus) {
                    aiKeyStatus.textContent = '✓ Key saved';
                    aiKeyStatus.style.color = 'var(--color-ok,#27AE60)';
                }
            });
        });
    }
});
