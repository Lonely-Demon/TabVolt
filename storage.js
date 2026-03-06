// storage.js — IndexedDB wrapper
// NO Chrome extension APIs. NO DOM. NO fetch. Ever.
// All DB operations isolated here. All functions take db as first param.

const DB_NAME = 'TabVoltDB';
const DB_VERSION = 2;

/**
 * Open (or create) the TabVolt IndexedDB.
 * Creates all 3 object stores on first open — Phase 3 stores created now.
 * @returns {Promise<IDBDatabase>}
 */
export function initDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);

        req.onupgradeneeded = (e) => {
            const db = e.target.result;

            if (!db.objectStoreNames.contains('tab_cycles')) {
                const store = db.createObjectStore('tab_cycles', { keyPath: 'id', autoIncrement: true });
                store.createIndex('session_id', 'session_id', { unique: false });
                store.createIndex('domain', 'domain', { unique: false });
                store.createIndex('timestamp', 'timestamp', { unique: false });
            }

            if (!db.objectStoreNames.contains('session_meta')) {
                db.createObjectStore('session_meta', { keyPath: 'session_id' });
            }

            if (!db.objectStoreNames.contains('domain_patterns')) {
                db.createObjectStore('domain_patterns', { keyPath: 'domain' });
            }

            // v2: suspend event tracking for savings analytics
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

/**
 * Batch write tab cycle records in a single transaction.
 * @param {IDBDatabase} db
 * @param {Object[]} records
 */
export function writeTabCycle(db, records) {
    return new Promise((resolve, reject) => {
        if (!db) { resolve(); return; }
        const tx = db.transaction('tab_cycles', 'readwrite');
        const store = tx.objectStore('tab_cycles');
        for (const rec of records) {
            store.add(rec);
        }
        tx.oncomplete = () => resolve();
        tx.onerror = (e) => reject(e.target.error);
    });
}

/**
 * Write or update session metadata (uses put for upsert).
 * @param {IDBDatabase} db
 * @param {Object} meta
 */
export function writeSessionMeta(db, meta) {
    return new Promise((resolve, reject) => {
        if (!db) { resolve(); return; }
        const tx = db.transaction('session_meta', 'readwrite');
        tx.objectStore('session_meta').put(meta);
        tx.oncomplete = () => resolve();
        tx.onerror = (e) => reject(e.target.error);
    });
}

/**
 * Upsert domain pattern. If domain exists, increment counts; else create.
 * Phase 3 populates this — schema created now.
 * @param {IDBDatabase} db
 * @param {string} domain
 * @param {boolean} returned — true if user returned to this tab
 */
export function updateDomainPattern(db, domain, returned) {
    return new Promise((resolve, reject) => {
        if (!db) { resolve(); return; }
        const tx = db.transaction('domain_patterns', 'readwrite');
        const store = tx.objectStore('domain_patterns');
        const getReq = store.get(domain);

        getReq.onsuccess = () => {
            const existing = getReq.result;
            if (existing) {
                existing.open_count += 1;
                if (returned) existing.returned_count += 1;
                existing.last_seen = Date.now();
                store.put(existing);
            } else {
                store.add({
                    domain,
                    open_count: 1,
                    returned_count: returned ? 1 : 0,
                    avg_idle_mins: 0,
                    last_seen: Date.now(),
                    preemptive_flag: false
                });
            }
        };

        tx.oncomplete = () => resolve();
        tx.onerror = (e) => reject(e.target.error);
    });
}

/**
 * Get all tab_cycle records for a session.
 * @param {IDBDatabase} db
 * @param {string} session_id
 * @returns {Promise<Object[]>}
 */
export function getSessionHistory(db, session_id) {
    return new Promise((resolve, reject) => {
        if (!db) { resolve([]); return; }
        const tx = db.transaction('tab_cycles', 'readonly');
        const idx = tx.objectStore('tab_cycles').index('session_id');
        const req = idx.getAll(session_id);
        req.onsuccess = () => resolve(req.result);
        req.onerror = (e) => reject(e.target.error);
    });
}

/**
 * Get most recent tab_cycle records for a domain (newest first).
 * @param {IDBDatabase} db
 * @param {string} domain
 * @param {number} limit
 * @returns {Promise<Object[]>}
 */
export function getRecentDomainCycles(db, domain, limit = 20) {
    return new Promise((resolve, reject) => {
        if (!db) { resolve([]); return; }
        const tx = db.transaction('tab_cycles', 'readonly');
        const idx = tx.objectStore('tab_cycles').index('domain');
        const range = IDBKeyRange.only(domain);
        const req = idx.openCursor(range, 'prev');
        const results = [];

        req.onsuccess = (e) => {
            const cursor = e.target.result;
            if (cursor && results.length < limit) {
                results.push(cursor.value);
                cursor.continue();
            } else {
                resolve(results);
            }
        };
        req.onerror = (e) => reject(e.target.error);
    });
}

/**
 * Delete tab_cycles older than `days` days.
 * @param {IDBDatabase} db
 * @param {number} days
 */
export function pruneOldSessions(db, days = 7) {
    return new Promise((resolve, reject) => {
        if (!db) { resolve(); return; }
        const cutoff = Date.now() - (days * 86400000);
        const tx = db.transaction('tab_cycles', 'readwrite');
        const idx = tx.objectStore('tab_cycles').index('timestamp');
        const range = IDBKeyRange.upperBound(cutoff);
        const req = idx.openCursor(range);

        req.onsuccess = (e) => {
            const cursor = e.target.result;
            if (cursor) {
                cursor.delete();
                cursor.continue();
            }
        };

        tx.oncomplete = () => resolve();
        tx.onerror = (e) => reject(e.target.error);
    });
}

/**
 * Log a tab suspension event for savings analytics.
 * @param {IDBDatabase} db
 * @param {Object} record — { session_id, timestamp, tab_id, domain, title,
 *   pre_suspend_score, pre_suspend_cpu, pre_suspend_mwh_rate, trigger }
 */
export function writeSuspendEvent(db, record) {
    return new Promise((resolve, reject) => {
        if (!db) { resolve(); return; }
        const tx = db.transaction('suspend_events', 'readwrite');
        tx.objectStore('suspend_events').add(record);
        tx.oncomplete = () => resolve();
        tx.onerror = (e) => reject(e.target.error);
    });
}
