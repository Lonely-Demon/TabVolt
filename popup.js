// popup.js — ES Module UI
//
// Rendering strategy: rows are keyed by tabId and updated in place — text
// nodes only change when their value changes, and rows are only re-ordered
// when the sort outcome actually differs. No innerHTML wipes on the hot
// path, so hover states, focus, and scroll position survive every refresh.

import { formatCO2Mass, isRestrictedUrl } from './energyscore.js';

// ============================================================================
// CONSTANTS + HELPERS
// ============================================================================

const REFRESH_MS = 2000;
const COMPANION_URL = 'http://127.0.0.1:9001/metrics';

const DEFAULT_FAVICON = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="%238A90A6" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>'
);

const ICON_SLEEP = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>`;
const ICON_SUSPEND = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`;
const ICON_WAKE = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
const ICON_AUDIO = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07"/></svg>`;
const ICON_SHIELD = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 1L3 5v6c0 5.5 3.8 10.7 9 12 5.2-1.3 9-6.5 9-12V5l-9-4z"/></svg>`;
const ICON_WARN = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
const ICON_BATTERY = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="1" y="6" width="18" height="12" rx="2"/><line x1="22" y1="10" x2="22" y2="14"/></svg>`;
const ICON_CHARGE = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`;

function formatKB(kb) {
    if (!kb) return '0 KB';
    return kb >= 1024 ? (kb / 1024).toFixed(1) + ' MB' : Math.round(kb) + ' KB';
}

function formatIdle(mins) {
    if (!mins || mins < 1) return '<1m';
    if (mins >= 60) return Math.floor(mins / 60) + 'h ' + Math.round(mins % 60) + 'm';
    return Math.round(mins) + 'm';
}

function formatCO2(grams) {
    const mass = `${formatCO2Mass(grams)} CO₂`;
    const km = grams / 130; // ~130 g CO₂ per km of driving
    return km >= 0.01 ? `${mass} · ${km.toFixed(2)} km 🚗` : mass;
}

const $ = (id) => document.getElementById(id);

// ============================================================================
// STATE
// ============================================================================

const rowMap = new Map();       // tabId -> { el, cells, prev }
let currentTabs = [];           // last payload array (browser order)
let sort = { key: null, dir: 1, clicks: 0 };  // key null = browser order
let searchQuery = '';
let lastPollStamp = 0;          // dedupes renders across refresh ticks
let lastPollTime = 0;           // for the "updated Xs ago" ticker
let aiTarget = null;            // { tabId, title } from the last AI response
let toastTimer = null;

// ============================================================================
// SYSTEM CHIPS
// ============================================================================

function renderSystemChips(system) {
    if (!system) return;
    setText('chip-cpu-val', `${system.cpu_pct ?? '—'}%`);
    setText('chip-ram-val', `${system.memory_pct ?? '—'}%`);

    const battIcon = $('chip-batt-icon');
    const battVal = $('chip-batt-val');
    if (system.battery_pct === null || system.battery_pct === undefined) {
        battIcon.innerHTML = ICON_BATTERY;
        battVal.textContent = '—';
        $('chip-batt').title = 'Battery status unavailable';
    } else {
        battIcon.innerHTML = system.is_charging ? ICON_CHARGE : ICON_BATTERY;
        battIcon.style.color = system.is_charging ? 'var(--warn)'
            : system.battery_pct < 15 ? 'var(--crit)'
                : system.battery_pct < 30 ? 'var(--warn)' : 'var(--ok)';
        battVal.textContent = `${system.battery_pct}%`;
        $('chip-batt').title = system.is_charging ? 'Battery (charging)' : 'Battery';
    }
}

// ============================================================================
// TAB TABLE — differential renderer
// ============================================================================

function stateSig(t) {
    return `${t.state}|${t.is_protected}|${t.audible}|${t.preemptive_flag}|${t.is_background}|${isRestrictedUrl(t.url)}`;
}

function createRow(t) {
    const el = document.createElement('div');
    el.dataset.tabId = t.tabId;

    const name = document.createElement('div');
    name.className = 'cell-name';
    const favicon = document.createElement('img');
    favicon.className = 'tab-favicon';
    favicon.width = 14; favicon.height = 14; favicon.alt = '';
    favicon.addEventListener('error', () => {
        if (favicon.src !== DEFAULT_FAVICON) favicon.src = DEFAULT_FAVICON;
    });
    const title = document.createElement('span');
    title.className = 'tab-title';
    const badges = document.createElement('span');
    badges.className = 'tab-badges';
    name.append(favicon, title, badges);

    const cpu = document.createElement('span');
    cpu.className = 'cell-num';
    const net = document.createElement('span');
    net.className = 'cell-num';
    const ram = document.createElement('span');
    ram.className = 'cell-num';

    const actions = document.createElement('span');
    actions.className = 'cell-actions';

    el.append(name, cpu, net, ram, actions);

    const row = { el, cells: { favicon, title, badges, cpu, net, ram, actions }, prev: {} };
    rowMap.set(t.tabId, row);
    return row;
}

function rebuildBadgesAndActions(row, t) {
    const { badges, actions } = row.cells;

    let badgeHtml = '';
    if (t.preemptive_flag && !t.is_protected) {
        badgeHtml += `<span class="preemptive-icon" title="Rarely revisited — likely safe to suspend">${ICON_WARN}</span>`;
    }
    let hasStateBadge = false;
    if (t.state === 'suspended') { badgeHtml += '<span class="tab-state-badge state-suspended">Zz</span>'; hasStateBadge = true; }
    else if (t.state === 'sleeping') { badgeHtml += '<span class="tab-state-badge state-sleeping">Sleep</span>'; hasStateBadge = true; }
    else if (t.audible) { badgeHtml += `<span class="tab-state-badge state-audible" title="Playing audio">${ICON_AUDIO}</span>`; hasStateBadge = true; }
    // The protected row already gets a persistent left rail (see .tab-row.protected
    // below) — only spend title-row space on the "Safe" text badge when there's no
    // competing state badge, so a protected+sleeping tab doesn't lose its title to
    // two stacked pills.
    if (t.is_protected && !hasStateBadge) {
        badgeHtml += '<span class="tab-state-badge state-protected" title="Protected from suspension">Safe</span>';
    }
    badges.innerHTML = badgeHtml;

    let actionsHtml = '';
    const shieldBtn = `<button class="tab-btn ${t.is_protected ? 'shield-on' : ''}" data-act="shield"
        title="${t.is_protected ? 'Remove protection' : 'Protect this tab'}"
        aria-label="${t.is_protected ? 'Remove protection' : 'Protect this tab'}">${ICON_SHIELD}</button>`;

    // Pausing animations requires script injection, which Chrome refuses on
    // its own internal pages, the Web Store, and similar — omit the button
    // there instead of surfacing an error after the click.
    const sleepBtn = isRestrictedUrl(t.url)
        ? ''
        : `<button class="tab-btn" data-act="sleep" title="Pause animations" aria-label="Pause animations">${ICON_SLEEP}</button>`;

    if (t.state === 'suspended') {
        actionsHtml = '';
    } else if (t.is_protected) {
        actionsHtml = shieldBtn;
    } else if (t.state === 'sleeping') {
        actionsHtml = shieldBtn +
            `<button class="tab-btn" data-act="wake" title="Wake tab" aria-label="Wake tab">${ICON_WAKE}</button>`;
    } else {
        actionsHtml = shieldBtn + sleepBtn +
            (t.is_background
                ? `<button class="tab-btn" data-act="suspend" title="Suspend tab" aria-label="Suspend tab">${ICON_SUSPEND}</button>`
                : '');
    }
    actions.innerHTML = actionsHtml;

    el_setRowClass(row.el, t);
}

function el_setRowClass(el, t) {
    let cls = 'tab-row';
    if (t.state === 'suspended') cls += ' suspended';
    else if (t.state === 'sleeping') cls += ' sleeping';
    if (t.is_protected) cls += ' protected';
    el.className = cls;
}

function updateRow(row, t) {
    const { cells, prev } = row;

    if (prev.title !== t.title) {
        cells.title.textContent = t.title;
        cells.title.title = t.title;
        prev.title = t.title;
    }
    const fav = t.favicon || DEFAULT_FAVICON;
    if (prev.favicon !== fav) {
        cells.favicon.src = fav;
        prev.favicon = fav;
    }

    // A leading "~" marks CPU/RAM as relative estimates, not real per-tab
    // measurements — Chrome doesn't expose that to Stable-channel extensions
    // (see the column headers' title text for the full explanation). Net is
    // real per-tab byte-counted data, so it doesn't get the marker.
    const suspended = t.state === 'suspended';
    const cpuText = suspended ? '—' : `~${(t.cpu_pct ?? 0).toFixed(1)}%`;
    if (prev.cpuText !== cpuText) { cells.cpu.textContent = cpuText; prev.cpuText = cpuText; }

    const netText = suspended ? '—' : formatKB(t.kb_transferred);
    if (prev.netText !== netText) { cells.net.textContent = netText; prev.netText = netText; }

    const ramText = suspended ? '—' : `~${(t.ram_pct ?? 0).toFixed(1)}%`;
    if (prev.ramText !== ramText) { cells.ram.textContent = ramText; prev.ramText = ramText; }

    const sig = stateSig(t);
    if (prev.sig !== sig) {
        rebuildBadgesAndActions(row, t);
        prev.sig = sig;
    }
}

function sortedFiltered(tabs) {
    let list = tabs.map((t, i) => ({ t, i }));
    if (searchQuery) {
        const q = searchQuery.toLowerCase();
        list = list.filter(({ t }) =>
            (t.title || '').toLowerCase().includes(q) || (t.domain || '').toLowerCase().includes(q));
    }
    if (sort.key) {
        const k = sort.key, d = sort.dir;
        list.sort((a, b) => {
            const va = a.t[k], vb = b.t[k];
            if (typeof va === 'string') return d * va.localeCompare(vb);
            return d * ((va || 0) - (vb || 0));
        });
    } else {
        list.sort((a, b) => a.i - b.i);
    }
    return list.map(({ t }) => t);
}

function renderTabList(tabs) {
    currentTabs = tabs || [];
    const listEl = $('tab-list');
    const emptyEl = $('list-empty');

    // Clear skeletons on first real data.
    listEl.querySelectorAll('.skeleton-row').forEach(n => n.remove());

    const visible = sortedFiltered(currentTabs);

    // Remove rows for closed tabs.
    const liveIds = new Set(currentTabs.map(t => t.tabId));
    for (const [tabId, row] of rowMap) {
        if (!liveIds.has(tabId)) {
            row.el.remove();
            rowMap.delete(tabId);
        }
    }

    // Update / create rows.
    const visibleIds = new Set();
    for (const t of visible) {
        visibleIds.add(t.tabId);
        let row = rowMap.get(t.tabId);
        if (!row) row = createRow(t);
        row.el.hidden = false;
        updateRow(row, t);
    }
    // Hide rows filtered out by search (keep them warm).
    for (const [tabId, row] of rowMap) {
        if (!visibleIds.has(tabId)) row.el.hidden = true;
    }

    // Re-append only if the visible order actually changed.
    const desired = visible.map(t => rowMap.get(t.tabId).el);
    const current = [...listEl.children].filter(el => !el.hidden);
    const orderChanged = desired.length !== current.length ||
        desired.some((el, i) => el !== current[i]);
    if (orderChanged) {
        const frag = document.createDocumentFragment();
        for (const t of visible) frag.appendChild(rowMap.get(t.tabId).el);
        for (const [tabId, row] of rowMap) {
            if (!visibleIds.has(tabId)) frag.appendChild(row.el);
        }
        listEl.appendChild(frag);
    }

    // Empty states.
    if (currentTabs.length === 0) {
        emptyEl.textContent = 'Waiting for first sample…';
        emptyEl.hidden = false;
    } else if (visible.length === 0) {
        emptyEl.textContent = `No tabs match “${searchQuery}”`;
        emptyEl.hidden = false;
    } else {
        emptyEl.hidden = true;
    }

    refreshOpenTooltip();
}

// ---- Row action delegation (one listener for every button) ----

$('tab-list').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    e.stopPropagation();
    const rowEl = btn.closest('.tab-row');
    const tabId = parseInt(rowEl.dataset.tabId, 10);
    const t = currentTabs.find(x => x.tabId === tabId);
    if (!t) return;

    switch (btn.dataset.act) {
        case 'suspend':
            chrome.runtime.sendMessage({ type: 'SUSPEND_TAB', tabId }, (res) => {
                if (res?.success) showToast(`Suspended “${truncate(t.title, 32)}”`);
                else showToast(res?.error || 'Could not suspend tab');
                refresh(true);
            });
            break;
        case 'sleep':
            chrome.runtime.sendMessage({ type: 'SLEEP_TAB', tabId }, (res) => {
                if (!res?.success) showToast(res?.error || 'Could not pause tab');
                refresh(true);
            });
            break;
        case 'wake':
            chrome.runtime.sendMessage({ type: 'WAKE_TAB', tabId }, () => refresh(true));
            break;
        case 'shield': {
            const msgType = t.is_protected ? 'CLEAR_PROTECTED' : 'SET_PROTECTED';
            chrome.runtime.sendMessage(
                { type: msgType, tabId, domain: t.domain || '', title: t.title },
                () => {
                    showToast(t.is_protected ? 'Protection removed' : `Protected “${truncate(t.title, 32)}”`);
                    refresh(true);
                }
            );
            break;
        }
    }
    hideTooltip();
});

// ---- Sorting ----

document.querySelectorAll('#list-header .sortable').forEach(col => {
    col.addEventListener('click', () => {
        const key = col.dataset.sort;
        if (sort.key !== key) {
            sort = { key, dir: key === 'title' ? 1 : -1, clicks: 1 };
        } else if (sort.clicks === 1) {
            sort.dir *= -1;
            sort.clicks = 2;
        } else {
            sort = { key: null, dir: 1, clicks: 0 }; // third click: browser order
        }
        updateSortIndicators();
        renderTabList(currentTabs);
    });
});

function updateSortIndicators() {
    document.querySelectorAll('#list-header .sortable').forEach(col => {
        const active = sort.key === col.dataset.sort;
        col.classList.toggle('sort-active', active);
        col.querySelector('.sort-arrow').textContent = active ? (sort.dir === 1 ? '▲' : '▼') : '';
    });
}

// ---- Search ----

$('search-input').addEventListener('input', (e) => {
    searchQuery = e.target.value.trim();
    renderTabList(currentTabs);
});

// ============================================================================
// TOOLTIP — single portal element, positioned next to the hovered row
// ============================================================================

const tooltipPanel = $('tab-tooltip-panel');
let hoverTimer = null;
let hoverTabId = null;

$('tab-list-container').addEventListener('mouseover', (e) => {
    const rowEl = e.target.closest('.tab-row');
    if (!rowEl) return;
    const tabId = parseInt(rowEl.dataset.tabId, 10);
    if (tabId === hoverTabId) return;
    hoverTabId = tabId;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => showTooltip(rowEl, tabId), 420);
});

$('tab-list-container').addEventListener('mouseleave', hideTooltip);
$('tab-list-container').addEventListener('scroll', hideTooltip, { passive: true });

function populateTooltipText(t) {
    $('tt-title').textContent = t.title;
    $('tt-cpu').textContent = `${t.cpu_pct}% · ${t.browser_cpu_share}% of browser`;
    $('tt-ram').textContent = `${t.ram_pct ?? 0}% · ${t.browser_mem_share ?? 0}% of browser`;
    $('tt-net').textContent = formatKB(t.kb_transferred);
    $('tt-idle').textContent = formatIdle(t.idle_mins);
}

function showTooltip(rowEl, tabId) {
    const t = currentTabs.find(x => x.tabId === tabId);
    if (!t || t.state === 'suspended' || !rowEl.isConnected) return;

    populateTooltipText(t);
    tooltipPanel.hidden = false;
    const rowRect = rowEl.getBoundingClientRect();
    const panelRect = tooltipPanel.getBoundingClientRect();
    let top = rowRect.bottom + 4;
    if (top + panelRect.height > window.innerHeight - 8) {
        top = rowRect.top - panelRect.height - 4;
    }
    tooltipPanel.style.top = `${Math.max(4, top)}px`;
    tooltipPanel.style.left = `${Math.max(4, window.innerWidth - panelRect.width - 16)}px`;
}

/**
 * Keep an already-open tooltip's numbers live across poll cycles. Without
 * this, the tooltip was a one-time snapshot taken 420ms after hover while
 * the row underneath kept re-rendering every refresh — leave the mouse in
 * place across a poll tick and the row and its own tooltip would show two
 * different values for the identical field on the identical tab.
 * Text-only: deliberately does not recompute position, so the box doesn't
 * jump around while you're reading it.
 */
function refreshOpenTooltip() {
    if (tooltipPanel.hidden || hoverTabId === null) return;
    const t = currentTabs.find(x => x.tabId === hoverTabId);
    if (!t || t.state === 'suspended') { hideTooltip(); return; }
    populateTooltipText(t);
}

function hideTooltip() {
    clearTimeout(hoverTimer);
    hoverTimer = null;
    hoverTabId = null;
    tooltipPanel.hidden = true;
}

// ============================================================================
// BUDGET STRIP
// ============================================================================

function renderBudget(budget, system) {
    const strip = $('budget-strip');
    const setBtn = $('btn-set-budget');
    const clearBtn = $('btn-clear-budget');

    if (!budget?.active) {
        strip.hidden = true;
        setBtn.hidden = false;
        clearBtn.hidden = true;
        return;
    }

    strip.hidden = false;
    setBtn.hidden = true;
    clearBtn.hidden = false;

    const label = $('budget-label');
    const bar = $('budget-bar');

    if (budget.batteryUnavailable) {
        bar.style.width = '100%';
        bar.style.background = 'var(--warn)';
        label.textContent = 'Budget set — battery status unavailable on this device';
        return;
    }

    const batt = system?.battery_pct ?? 100;
    const target = budget.targetPct || 20;
    const pct = Math.max(0, Math.min(100, ((batt - target) / (100 - target)) * 100));
    bar.style.width = pct + '%';
    bar.style.background = pct > 40 ? 'var(--ok)' : pct > 15 ? 'var(--warn)' : 'var(--crit)';

    let text = `${budget.onTrack ? 'On track' : 'Over budget'} · ${budget.remainingMins ?? 0}m left · floor ${target}%`;
    if (budget.lastAction) text += ` · ${budget.lastAction}`;
    label.textContent = text;
}

// ============================================================================
// FOOTER
// ============================================================================

function renderFooter(session) {
    if (!session) return;
    setText('tile-energy-val', (session.total_mwh || 0).toFixed(1));
    setText('footer-co2', formatCO2(session.total_co2_grams || 0));
}

// Lightweight 1s ticker — touches one text node, never re-renders the list.
setInterval(() => {
    if (!lastPollTime) return;
    const ago = Math.max(0, Math.round((Date.now() - lastPollTime) / 1000));
    setText('footer-updated', ago > 120 ? 'Stalled — reopen popup' : `Updated ${ago}s ago`);
}, 1000);

// ============================================================================
// HEATMAP
// ============================================================================

const heatmapCanvas = $('heatmap-canvas');
const heatmapCtx = heatmapCanvas ? heatmapCanvas.getContext('2d') : null;
const faviconCache = new Map();
let heatmapRerenderTimer = null;

function scoreToColor(score) {
    if (score >= 70) return '#C0392B';
    if (score >= 30) {
        const t = (score - 30) / 40;
        return `rgb(${Math.round(243 + (192 - 243) * t)},${Math.round(156 + (57 - 156) * t)},${Math.round(18 + (43 - 18) * t)})`;
    }
    const t = score / 30;
    return `rgb(${Math.round(39 + (243 - 39) * t)},${Math.round(174 + (156 - 174) * t)},${Math.round(96 + (18 - 96) * t)})`;
}

/**
 * Width the heatmap canvas may actually draw into — the content box of its
 * parent card, minus that card's own horizontal padding. Computed live
 * (not a hardcoded px constant) so the canvas always fits the popup's
 * current width instead of clipping or leaving dead space.
 */
function heatmapAvailableWidth(canvas) {
    const section = canvas.parentElement;
    const cs = getComputedStyle(section);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    return Math.max(160, section.clientWidth - padX);
}

function renderHeatmap(buffer) {
    if (!heatmapCtx || !buffer) return;
    const canvas = heatmapCanvas;
    const ctx = heatmapCtx;
    const dpr = window.devicePixelRatio || 1;
    const availableW = heatmapAvailableWidth(canvas);

    const entries = Object.entries(buffer)
        .map(([id, data]) => ({ id, title: data.title, favicon: data.favicon, url: data.url, order: data.order ?? 999, scores: data.scores }))
        .filter(e => e.scores.length > 0)
        .sort((a, b) => a.order - b.order)
        .slice(0, 10);

    if (entries.length === 0) {
        canvas.width = availableW * dpr; canvas.height = 30 * dpr;
        canvas.style.width = availableW + 'px'; canvas.style.height = '30px';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = '#6E7487';
        ctx.font = '11px -apple-system, sans-serif';
        ctx.fillText('Waiting for data…', availableW / 2 - 50, 18);
        return;
    }

    const cellH = 14, gapX = 1, gapY = 3;
    const cols = 30;
    const labelW = 24;
    // Cell width fills whatever room the popup currently has — 30 cycles
    // always fit, they just render narrower on a slimmer popup.
    const cellW = Math.max(4, (availableW - labelW - cols * gapX) / cols);
    const totalH = entries.length * (cellH + gapY) - gapY;
    const cssW = labelW + cols * (cellW + gapX);
    const cssH = Math.max(totalH + 4, 30);

    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, cssW, cssH);

    setText('heatmap-tab-count', `${entries.length} tab${entries.length !== 1 ? 's' : ''}`);

    entries.forEach((entry, rowIdx) => {
        const y = rowIdx * (cellH + gapY);
        const iconSize = 14;
        const iconY = y + (cellH - iconSize) / 2;

        // Chrome's _favicon API resolves icons for all URLs; fall back to a
        // letter circle while it loads or if it fails.
        const tabUrl = entry.url || '';
        const iconSrc = tabUrl
            ? `${chrome.runtime.getURL('_favicon/')}?pageUrl=${encodeURIComponent(tabUrl)}&size=64`
            : (entry.favicon || '');

        if (iconSrc && faviconCache.has(iconSrc)) {
            const img = faviconCache.get(iconSrc);
            if (img.complete && img.naturalHeight !== 0) {
                ctx.drawImage(img, (labelW - iconSize) / 2, iconY, iconSize, iconSize);
            } else {
                drawLetterCircle(ctx, entry, y, labelW, cellH);
            }
        } else if (iconSrc) {
            drawLetterCircle(ctx, entry, y, labelW, cellH);
            const img = new Image();
            img.onload = () => {
                faviconCache.set(iconSrc, img);
                clearTimeout(heatmapRerenderTimer);
                heatmapRerenderTimer = setTimeout(() => renderHeatmap(buffer), 60);
            };
            img.onerror = () => faviconCache.set(iconSrc, new Image());
            img.src = iconSrc;
        } else {
            drawLetterCircle(ctx, entry, y, labelW, cellH);
        }

        for (let col = 0; col < cols; col++) {
            const dataIdx = col - (cols - entry.scores.length);
            const x = labelW + col * (cellW + gapX);
            ctx.fillStyle = (dataIdx < 0 || dataIdx >= entry.scores.length)
                ? '#20202E'
                : scoreToColor(entry.scores[dataIdx]);
            ctx.fillRect(x, y, cellW, cellH);
        }
    });
}

function drawLetterCircle(ctx, entry, y, labelW, cellH) {
    const cx = labelW / 2;
    const cy = y + cellH / 2;
    ctx.beginPath();
    ctx.arc(cx, cy, 6, 0, Math.PI * 2);
    ctx.fillStyle = '#2A2A3C';
    ctx.fill();
    ctx.fillStyle = '#F0742A';
    ctx.font = 'bold 8px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText((entry.title || '?').charAt(0).toUpperCase(), cx, cy);
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
}

// ============================================================================
// TOOLBAR ACTIONS
// ============================================================================

$('btn-suspend-top').addEventListener('click', () => {
    const btn = $('btn-suspend-top');
    btn.disabled = true;
    btn.textContent = 'Suspending…';
    chrome.runtime.sendMessage({ type: 'SUSPEND_TOP_N', n: 3 }, (res) => {
        const n = res?.suspended || 0;
        showToast(n > 0 ? `${n} tab${n !== 1 ? 's' : ''} suspended` : 'Nothing suspendable right now');
        btn.textContent = 'Suspend idle';
        btn.disabled = false;
        refresh(true);
    });
});

$('btn-ai-suggest').addEventListener('click', () => {
    const panel = $('ai-panel');
    const text = $('ai-text');
    const actBtn = $('btn-act-now');
    panel.hidden = false;
    text.textContent = 'Analyzing your tabs…';
    text.classList.add('thinking');
    actBtn.hidden = true;
    $('btn-ai-suggest').disabled = true;

    chrome.runtime.sendMessage({ type: 'GET_AI_SUGGESTION' }, (response) => {
        text.textContent = response?.suggestion || 'Unable to get a suggestion.';
        text.classList.remove('thinking');
        $('btn-ai-suggest').disabled = false;

        aiTarget = response?.targetTabId
            ? { tabId: response.targetTabId, title: response.targetTitle || 'tab' }
            : null;
        if (aiTarget) {
            actBtn.textContent = `Suspend “${truncate(aiTarget.title, 26)}”`;
            actBtn.hidden = false;
        }
    });
});

$('btn-act-now').addEventListener('click', () => {
    if (!aiTarget) return;
    const { tabId, title } = aiTarget;
    aiTarget = null;
    chrome.runtime.sendMessage({ type: 'SUSPEND_SPECIFIC', tabId }, (res) => {
        showToast(res?.success ? `Suspended “${truncate(title, 32)}”` : (res?.error || 'Could not suspend tab'));
        refresh(true);
    });
    $('ai-panel').hidden = true;
});

$('btn-ai-dismiss').addEventListener('click', () => {
    $('ai-panel').hidden = true;
    aiTarget = null;
});

$('btn-history').addEventListener('click', () => {
    chrome.tabs.create({ url: 'history.html' });
});

// ============================================================================
// SETTINGS DRAWER
// ============================================================================

$('btn-settings').addEventListener('click', () => {
    const drawer = $('settings-drawer');
    const open = drawer.hidden;
    drawer.hidden = !open;
    $('btn-settings').setAttribute('aria-expanded', String(open));
    if (open) {
        loadDrawerState();
        checkCompanion();
    }
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        $('settings-drawer').hidden = true;
        $('btn-settings').setAttribute('aria-expanded', 'false');
        $('ai-panel').hidden = true;
        hideTooltip();
    }
});

async function loadDrawerState() {
    const data = await chrome.storage.local.get(['groqApiKey', 'settings', 'energyBudget']);

    const status = $('ai-key-status');
    status.textContent = data.groqApiKey ? '✓ Key set' : 'No key';
    status.style.color = data.groqApiKey ? 'var(--ok)' : 'var(--warn)';

    $('auto-suspend-select').value = String(data.settings?.autoSuspendMins ?? 5);

    $('btn-set-budget').hidden = !!data.energyBudget;
    $('btn-clear-budget').hidden = !data.energyBudget;
}

$('auto-suspend-select').addEventListener('change', async (e) => {
    const autoSuspendMins = parseInt(e.target.value, 10) || 0;
    const data = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...(data.settings || {}), autoSuspendMins } });
    showToast(autoSuspendMins === 0 ? 'Auto-suspend off' : `Auto-suspend after ${autoSuspendMins} min idle`);
});

$('btn-save-key').addEventListener('click', () => {
    const keyInput = $('groq-key-input');
    const key = keyInput.value.trim();
    if (!key) return;
    chrome.storage.local.set({ groqApiKey: key }, () => {
        keyInput.value = '';
        const status = $('ai-key-status');
        status.textContent = '✓ Key saved';
        status.style.color = 'var(--ok)';
        showToast('API key saved');
    });
});

$('btn-set-budget').addEventListener('click', () => {
    const targetPct = parseInt($('budget-target-pct').value, 10);
    const targetTimeStr = $('budget-target-time').value;
    if (!targetPct || targetPct < 10 || targetPct > 90 || !targetTimeStr) {
        showToast('Enter a floor (10–90%) and a time');
        return;
    }
    const [h, m] = targetTimeStr.split(':').map(Number);
    const targetDate = new Date();
    targetDate.setHours(h, m, 0, 0);
    if (targetDate.getTime() <= Date.now()) targetDate.setDate(targetDate.getDate() + 1);
    chrome.runtime.sendMessage(
        { type: 'SET_BUDGET', targetPct, targetTime: targetDate.toISOString() },
        () => {
            showToast(`Budget set: stay above ${targetPct}%`);
            $('budget-target-pct').value = '';
            $('budget-target-time').value = '';
            loadDrawerState();
            refresh(true);
        }
    );
});

$('btn-clear-budget').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'CLEAR_BUDGET' }, () => {
        showToast('Budget cleared');
        loadDrawerState();
        refresh(true);
    });
});

// ============================================================================
// COMPANION
// ============================================================================

async function checkCompanion() {
    const badge = $('companion-badge');
    const chip = $('chip-comp');
    try {
        const res = await fetch(COMPANION_URL, { signal: AbortSignal.timeout(2500) });
        if (!res.ok) throw new Error('not ok');
        const metrics = await res.json();

        badge.textContent = 'ONLINE';
        badge.className = 'badge-online';
        $('enhanced-toggle').checked = true;
        $('companion-setup').hidden = true;
        $('companion-panel').hidden = false;

        const temp = metrics.cpu_temp_c === -1 ? 'N/A' : `${metrics.cpu_temp_c.toFixed(1)}°C`;
        const igpu = metrics.igpu_pct === -1 ? 'N/A' : `${metrics.igpu_pct.toFixed(1)}%`;
        setText('comp-temp', `Temp: ${temp}`);
        setText('comp-igpu', `iGPU: ${igpu}`);
        setText('comp-source', metrics.temp_source === 'acpi_thermal_zone' ? '(ACPI)' : '');

        if (metrics.cpu_temp_c !== -1) {
            chip.hidden = false;
            setText('chip-comp-val', temp);
        } else {
            chip.hidden = true;
        }
    } catch (_) {
        badge.textContent = 'OFFLINE';
        badge.className = 'badge-offline';
        $('enhanced-toggle').checked = false;
        $('companion-panel').hidden = true;
        chip.hidden = true;
    }
}

$('enhanced-toggle').addEventListener('change', async (e) => {
    if (e.target.checked) {
        await checkCompanion();
        if (!$('enhanced-toggle').checked) {
            $('companion-setup').hidden = false; // still offline — show setup help
        }
    } else {
        $('companion-setup').hidden = true;
        $('companion-panel').hidden = true;
        $('chip-comp').hidden = true;
        $('companion-badge').textContent = 'OFFLINE';
        $('companion-badge').className = 'badge-offline';
    }
});

// ============================================================================
// UTILITIES
// ============================================================================

function setText(id, val) {
    const el = $(id);
    if (el && el.textContent !== String(val)) el.textContent = val;
}

function truncate(s, n) {
    return s && s.length > n ? s.slice(0, n) + '…' : (s || '');
}

function showToast(msg) {
    const toast = $('toast');
    toast.textContent = msg;
    toast.hidden = false;
    // Force reflow so the transition replays on rapid successive toasts.
    void toast.offsetWidth;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        toast.classList.remove('show');
        toastTimer = setTimeout(() => { toast.hidden = true; }, 200);
    }, 2200);
}

// ============================================================================
// DATA REFRESH
// ============================================================================

async function refresh(force = false) {
    let data;
    try {
        data = await chrome.storage.session.get(
            ['tabs', 'system', 'session', 'poll', 'heatmap_buffer', 'budget']
        );
    } catch (_) { return; }

    if (!data?.tabs) return; // keep skeletons until the first sample lands

    const stamp = data.poll?.last_updated || 0;
    lastPollTime = stamp || lastPollTime;
    if (!force && stamp === lastPollStamp) return; // nothing new — skip render
    lastPollStamp = stamp;

    renderSystemChips(data.system);
    renderTabList(data.tabs);
    renderBudget(data.budget, data.system);
    renderFooter(data.session);
    renderHeatmap(data.heatmap_buffer);
}

refresh(true);
setInterval(refresh, REFRESH_MS);
checkCompanion();
