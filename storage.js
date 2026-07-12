// storage.js — IndexedDB wrapper
// NO Chrome extension APIs. NO DOM. NO fetch. Ever.
// The single source of truth for the TabVolt schema. All DB operations
// are isolated here; every function takes `db` as its first parameter.
// Imported by background.js (service worker), analytics.js, and history.js.

const DB_NAME = 'TabVoltDB';
const DB_VERSION = 2;

// Retention windows applied by pruneAll().
const RETENTION_DAYS = {
    tab_cycles: 7,
    suspend_events: 30,
    session_meta: 30,
    domain_patterns: 30
};

/**
 * Open (or create) the TabVolt IndexedDB.
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
        if (!db || records.length === 0) { resolve(); return; }
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
 * Log a tab suspension event for savings analytics.
 * @param {IDBDatabase} db
 * @param {Object} record — { session_id, timestamp, tab_id, domain, title,
 *   pre_suspend_score, pre_suspend_cpu, mwh_per_hour, poll_interval_ms, trigger }
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

/**
 * Batch upsert domain pattern records in a single transaction.
 * @param {IDBDatabase} db
 * @param {Object[]} patterns — full records keyed by `domain`
 */
export function putDomainPatterns(db, patterns) {
    return new Promise((resolve, reject) => {
        if (!db || patterns.length === 0) { resolve(); return; }
        const tx = db.transaction('domain_patterns', 'readwrite');
        const store = tx.objectStore('domain_patterns');
        for (const p of patterns) store.put(p);
        tx.oncomplete = () => resolve();
        tx.onerror = (e) => reject(e.target.error);
    });
}

/**
 * Load every domain pattern record (used once at service-worker start to
 * warm the in-memory cache).
 * @param {IDBDatabase} db
 * @returns {Promise<Object[]>}
 */
export function getAllDomainPatterns(db) {
    return getAllRecords(db, 'domain_patterns');
}

/**
 * Get every record in a store.
 * @param {IDBDatabase} db
 * @param {string} storeName
 * @returns {Promise<Object[]>}
 */
export function getAllRecords(db, storeName) {
    return new Promise((resolve, reject) => {
        if (!db) { resolve([]); return; }
        const tx = db.transaction(storeName, 'readonly');
        const req = tx.objectStore(storeName).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = (e) => reject(e.target.error);
    });
}

/**
 * Get records with `timestamp >= sinceTs` using the timestamp index —
 * avoids loading the whole store into memory for time-filtered views.
 * Only valid for stores with a 'timestamp' index (tab_cycles, suspend_events).
 * @param {IDBDatabase} db
 * @param {string} storeName
 * @param {number} sinceTs
 * @returns {Promise<Object[]>}
 */
export function getRecordsSince(db, storeName, sinceTs) {
    return new Promise((resolve, reject) => {
        if (!db) { resolve([]); return; }
        const tx = db.transaction(storeName, 'readonly');
        const idx = tx.objectStore(storeName).index('timestamp');
        const req = idx.getAll(IDBKeyRange.lowerBound(sinceTs));
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = (e) => reject(e.target.error);
    });
}

/**
 * Get all tab_cycle records for a session.
 * @param {IDBDatabase} db
 * @param {string} session_id
 * @returns {Promise<Object[]>}
 */
export function getSessionCycles(db, session_id) {
    return new Promise((resolve, reject) => {
        if (!db) { resolve([]); return; }
        const tx = db.transaction('tab_cycles', 'readonly');
        const idx = tx.objectStore('tab_cycles').index('session_id');
        const req = idx.getAll(session_id);
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = (e) => reject(e.target.error);
    });
}

/** Delete records older than cutoff via the store's timestamp index. */
function pruneByTimestampIndex(db, storeName, cutoff) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const idx = tx.objectStore(storeName).index('timestamp');
        const req = idx.openCursor(IDBKeyRange.upperBound(cutoff));
        req.onsuccess = (e) => {
            const cursor = e.target.result;
            if (cursor) { cursor.delete(); cursor.continue(); }
        };
        tx.oncomplete = () => resolve();
        tx.onerror = (e) => reject(e.target.error);
    });
}

/** Delete records whose `field` is older than cutoff (full scan — for small stores). */
function pruneByFieldScan(db, storeName, field, cutoff) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const req = tx.objectStore(storeName).openCursor();
        req.onsuccess = (e) => {
            const cursor = e.target.result;
            if (cursor) {
                if ((cursor.value[field] || 0) < cutoff) cursor.delete();
                cursor.continue();
            }
        };
        tx.oncomplete = () => resolve();
        tx.onerror = (e) => reject(e.target.error);
    });
}

/**
 * Apply retention windows to every store. Called once at service-worker start.
 * @param {IDBDatabase} db
 */
export async function pruneAll(db) {
    if (!db) return;
    const now = Date.now();
    const cutoff = (days) => now - days * 86400000;
    await pruneByTimestampIndex(db, 'tab_cycles', cutoff(RETENTION_DAYS.tab_cycles));
    await pruneByTimestampIndex(db, 'suspend_events', cutoff(RETENTION_DAYS.suspend_events));
    await pruneByFieldScan(db, 'session_meta', 'end_time', cutoff(RETENTION_DAYS.session_meta));
    await pruneByFieldScan(db, 'domain_patterns', 'last_seen', cutoff(RETENTION_DAYS.domain_patterns));
}
