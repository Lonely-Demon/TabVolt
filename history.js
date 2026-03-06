// history.js — PHASE 2 Session History Page
// Pure IndexedDB reads. No chrome extension APIs needed.

const DB_NAME = 'TabVoltDB';
const DB_VERSION = 2;

let db = null;
let allSessions = [];
let currentSessionId = null;
let sortCol = 'energyscore';
let sortAsc = false;
let activeFilter = 'all';      // 'all' | 'today' | '7d' | '30d' | 'date'
let filterDate = null;          // Date string for specific date filter

// ============================================================================
// DB
// ============================================================================

function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
            const d = e.target.result;
            if (!d.objectStoreNames.contains('tab_cycles')) {
                const s = d.createObjectStore('tab_cycles', { keyPath: 'id', autoIncrement: true });
                s.createIndex('session_id', 'session_id', { unique: false });
                s.createIndex('domain', 'domain', { unique: false });
                s.createIndex('timestamp', 'timestamp', { unique: false });
            }
            if (!d.objectStoreNames.contains('session_meta'))
                d.createObjectStore('session_meta', { keyPath: 'session_id' });
            if (!d.objectStoreNames.contains('domain_patterns'))
                d.createObjectStore('domain_patterns', { keyPath: 'domain' });
            if (!d.objectStoreNames.contains('suspend_events')) {
                const se = d.createObjectStore('suspend_events', { keyPath: 'id', autoIncrement: true });
                se.createIndex('session_id', 'session_id', { unique: false });
                se.createIndex('timestamp', 'timestamp', { unique: false });
            }
        };
        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror = (e) => reject(e.target.error);
    });
}

function getAllSessions(db) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction('session_meta', 'readonly');
        const req = tx.objectStore('session_meta').getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = (e) => reject(e.target.error);
    });
}

function getSessionCycles(db, sessionId) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction('tab_cycles', 'readonly');
        const idx = tx.objectStore('tab_cycles').index('session_id');
        const req = idx.getAll(sessionId);
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = (e) => reject(e.target.error);
    });
}

// ============================================================================
// RENDER SIDEBAR
// ============================================================================

function getFilteredSessions() {
    const now = Date.now();
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    return allSessions.filter(s => {
        const t = s.start_time || 0;
        switch (activeFilter) {
            case 'today':
                return t >= startOfToday.getTime();
            case '7d':
                return t >= now - 7 * 24 * 60 * 60 * 1000;
            case '30d':
                return t >= now - 30 * 24 * 60 * 60 * 1000;
            case 'date':
                if (!filterDate) return true;
                const d = new Date(filterDate);
                const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
                const dayEnd = dayStart + 24 * 60 * 60 * 1000;
                return t >= dayStart && t < dayEnd;
            default:
                return true;
        }
    });
}

function renderSessionList() {
    const listEl = document.getElementById('session-list');
    const countEl = document.getElementById('filter-count');

    const filtered = getFilteredSessions();

    // Show filter count
    if (countEl) {
        if (activeFilter === 'all' && allSessions.length === filtered.length) {
            countEl.textContent = '';
        } else {
            countEl.textContent = `Showing ${filtered.length} of ${allSessions.length} sessions`;
        }
    }

    if (filtered.length === 0) {
        const msg = allSessions.length === 0
            ? 'No sessions recorded yet.'
            : 'No sessions match the selected filter.';
        listEl.innerHTML = `<p class="empty-msg" style="padding:20px;font-size:12px;">${msg}</p>`;
        return;
    }

    // Sort by start_time descending (newest first)
    filtered.sort((a, b) => (b.start_time || 0) - (a.start_time || 0));

    listEl.innerHTML = filtered.map(s => {
        const date = new Date(s.start_time || 0);
        const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        const timeStr = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        const duration = s.end_time && s.start_time
            ? Math.round((s.end_time - s.start_time) / 60000) + 'm'
            : '—';
        const mwh = (s.total_mwh || 0).toFixed(1);
        const co2 = (s.total_co2_grams || 0).toFixed(1);
        const active = s.session_id === currentSessionId ? ' active' : '';

        return `<div class="session-item${active}" data-sid="${s.session_id}">
            <div class="session-date">${dateStr} · ${timeStr}</div>
            <div class="session-stats">
                <span>${duration}</span>
                <span>${mwh} mWh</span>
                <span>${co2}g CO₂</span>
                <span>${s.total_tabs_monitored || 0} tabs</span>
            </div>
        </div>`;
    }).join('');

    listEl.querySelectorAll('.session-item').forEach(item => {
        item.addEventListener('click', () => {
            currentSessionId = item.dataset.sid;
            renderSessionList();
            loadSessionDetail(currentSessionId);
        });
    });
}

// ============================================================================
// RENDER DETAIL TABLE
// ============================================================================

async function loadSessionDetail(sessionId) {
    const titleEl = document.getElementById('detail-title');
    const contentEl = document.getElementById('detail-content');

    titleEl.textContent = 'Loading…';
    contentEl.innerHTML = '';

    const cycles = await getSessionCycles(db, sessionId);
    if (cycles.length === 0) {
        titleEl.textContent = 'No Data';
        contentEl.innerHTML = '<p class="empty-msg">No tab cycles recorded for this session.</p>';
        return;
    }

    // Aggregate by tab_id (same physical browser tab), fall back to domain
    const agg = new Map();
    for (const c of cycles) {
        // Use tab_id if available, otherwise fall back to domain
        const key = c.tab_id != null ? `tab_${c.tab_id}` : `dom_${c.domain}`;
        if (!agg.has(key)) {
            agg.set(key, {
                title: c.title, domain: c.domain,
                titles: new Set(),
                latestTimestamp: 0,
                peakScore: 0, cpuSum: 0, kbSum: 0, mwhSum: 0, co2Sum: 0,
                idleMax: 0, count: 0
            });
        }
        const a = agg.get(key);
        a.titles.add(c.title);
        // Keep the most recent title as the display label
        const ts = c.timestamp || 0;
        if (ts >= a.latestTimestamp) {
            a.latestTimestamp = ts;
            a.title = c.title;
        }
        a.peakScore = Math.max(a.peakScore, c.energyscore || 0);
        a.cpuSum += c.cpu_pct || 0;
        a.kbSum += c.kb_transferred || 0;
        a.mwhSum += c.mwh_estimated || 0;
        a.co2Sum += c.co2_grams || 0;
        a.idleMax = Math.max(a.idleMax, c.idle_mins || 0);
        a.count++;
    }

    let rows = Array.from(agg.values()).map(a => {
        // If a tab had multiple titles (e.g., Spotify songs), note it
        const uniqueTitles = a.titles.size;
        const displayTitle = uniqueTitles > 1
            ? `${a.title} (+${uniqueTitles - 1} more)`
            : a.title;
        return {
            title: displayTitle,
            domain: a.domain,
            peakScore: a.peakScore,
            avgCpu: a.count > 0 ? Math.round((a.cpuSum / a.count) * 10) / 10 : 0,
            totalKB: Math.round(a.kbSum),
            totalMwh: Math.round(a.mwhSum * 1000) / 1000,
            co2g: Math.round(a.co2Sum * 1000) / 1000,
            idleTime: Math.round(a.idleMax)
        };
    });

    // Sort
    rows.sort((a, b) => {
        const va = a[sortCol], vb = b[sortCol];
        if (typeof va === 'string') return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
        return sortAsc ? va - vb : vb - va;
    });

    // Session info
    const session = allSessions.find(s => s.session_id === sessionId);
    if (session) {
        const date = new Date(session.start_time || 0);
        titleEl.textContent = `Session: ${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
    } else {
        titleEl.textContent = 'Session Detail';
    }

    const columns = [
        { key: 'title', label: 'Tab Title' },
        { key: 'domain', label: 'Domain' },
        { key: 'peakScore', label: 'Peak Score' },
        { key: 'avgCpu', label: 'Avg CPU%' },
        { key: 'totalKB', label: 'Total KB' },
        { key: 'totalMwh', label: 'Total mWh' },
        { key: 'co2g', label: 'CO₂g' },
        { key: 'idleTime', label: 'Idle (min)' }
    ];

    const arrow = (key) => sortCol === key ? (sortAsc ? ' ↑' : ' ↓') : '';

    const thead = columns.map(c =>
        `<th data-col="${c.key}">${c.label}<span class="sort-arrow">${arrow(c.key)}</span></th>`
    ).join('');

    const tbody = rows.map(r =>
        `<tr>
            <td>${escapeHtml(r.title.length > 40 ? r.title.slice(0, 40) + '…' : r.title)}</td>
            <td>${escapeHtml(r.domain)}</td>
            <td>${r.peakScore}</td>
            <td>${r.avgCpu}%</td>
            <td>${formatKB(r.totalKB)}</td>
            <td>${r.totalMwh.toFixed(3)}</td>
            <td>${r.co2g.toFixed(3)}</td>
            <td>${r.idleTime}m</td>
        </tr>`
    ).join('');

    // Summary row
    const totals = rows.reduce((acc, r) => ({
        peakScore: Math.max(acc.peakScore, r.peakScore),
        avgCpu: acc.avgCpu + r.avgCpu,
        totalKB: acc.totalKB + r.totalKB,
        totalMwh: acc.totalMwh + r.totalMwh,
        co2g: acc.co2g + r.co2g,
        idleTime: Math.max(acc.idleTime, r.idleTime)
    }), { peakScore: 0, avgCpu: 0, totalKB: 0, totalMwh: 0, co2g: 0, idleTime: 0 });

    const summaryRow = `<tr class="summary-row">
        <td colspan="2">Totals (${rows.length} tabs)</td>
        <td>${totals.peakScore}</td>
        <td>${(totals.avgCpu / (rows.length || 1)).toFixed(1)}%</td>
        <td>${formatKB(totals.totalKB)}</td>
        <td>${totals.totalMwh.toFixed(3)}</td>
        <td>${totals.co2g.toFixed(3)}</td>
        <td>${totals.idleTime}m</td>
    </tr>`;

    contentEl.innerHTML = `<table class="data-table">
        <thead><tr>${thead}</tr></thead>
        <tbody>${tbody}${summaryRow}</tbody>
    </table>`;

    // Sortable headers
    contentEl.querySelectorAll('th[data-col]').forEach(th => {
        th.addEventListener('click', () => {
            const col = th.dataset.col;
            if (sortCol === col) sortAsc = !sortAsc;
            else { sortCol = col; sortAsc = false; }
            loadSessionDetail(sessionId);
        });
    });
}

// ============================================================================
// EXPORT
// ============================================================================

async function exportSession() {
    if (!currentSessionId) return;
    const cycles = await getSessionCycles(db, currentSessionId);
    const session = allSessions.find(s => s.session_id === currentSessionId);
    const payload = { session: session || {}, cycles };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tabvolt-session-${currentSessionId.slice(0, 8)}.json`;
    a.click();
    URL.revokeObjectURL(url);
}

// ============================================================================
// HELPERS
// ============================================================================

function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}

function formatKB(kb) {
    if (!kb) return '0 KB';
    return kb >= 1024 ? (kb / 1024).toFixed(1) + ' MB' : Math.round(kb) + ' KB';
}

// ============================================================================
// INIT
// ============================================================================

document.addEventListener('DOMContentLoaded', async () => {
    try {
        db = await openDB();
        allSessions = await getAllSessions(db);
        renderSessionList();

        // Auto-select most recent session
        if (allSessions.length > 0) {
            allSessions.sort((a, b) => (b.start_time || 0) - (a.start_time || 0));
            currentSessionId = allSessions[0].session_id;
            renderSessionList();
            loadSessionDetail(currentSessionId);
        }
    } catch (e) {
        console.error('TabVolt History: DB error', e);
        document.getElementById('session-list').innerHTML =
            '<p class="empty-msg" style="padding:20px;font-size:12px;">Error loading sessions.</p>';
    }

    document.getElementById('btn-export').addEventListener('click', exportSession);

    // ---- Filter controls ----
    const pills = document.querySelectorAll('.filter-pill');
    const dateInput = document.getElementById('filter-date');

    pills.forEach(pill => {
        pill.addEventListener('click', () => {
            pills.forEach(p => p.classList.remove('active'));
            pill.classList.add('active');
            activeFilter = pill.dataset.range;
            // Clear date picker when using a preset
            if (activeFilter !== 'date' && dateInput) dateInput.value = '';
            filterDate = null;
            renderSessionList();
        });
    });

    if (dateInput) {
        dateInput.addEventListener('change', () => {
            const val = dateInput.value;
            if (val) {
                activeFilter = 'date';
                filterDate = val;
                // Deactivate all pills visually
                pills.forEach(p => p.classList.remove('active'));
            } else {
                activeFilter = 'all';
                filterDate = null;
                pills.forEach(p => {
                    p.classList.toggle('active', p.dataset.range === 'all');
                });
            }
            renderSessionList();
        });
    }
});
