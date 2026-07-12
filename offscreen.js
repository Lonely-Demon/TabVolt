// offscreen.js — battery telemetry relay
// The Battery Status API is unavailable in MV3 service workers, so this
// offscreen document (reason: BATTERY_STATUS) reads it and forwards state
// to the service worker. Event-driven with a slow heartbeat so a missed
// message never leaves the worker with stale data for long.

const HEARTBEAT_MS = 60000;

function send(payload) {
    // The service worker may be mid-restart; sendMessage both delivers the
    // reading and wakes it. Swallow "no receiver" races.
    try {
        chrome.runtime.sendMessage(payload).catch(() => { });
    } catch (_) { }
}

function report(b) {
    send({
        type: 'BATTERY_UPDATE',
        level: Math.round(b.level * 100),
        charging: b.charging
    });
}

if (navigator.getBattery) {
    navigator.getBattery().then((b) => {
        report(b);
        b.addEventListener('levelchange', () => report(b));
        b.addEventListener('chargingchange', () => report(b));
        setInterval(() => report(b), HEARTBEAT_MS);
    }).catch(() => {
        send({ type: 'BATTERY_UNAVAILABLE' });
    });
} else {
    send({ type: 'BATTERY_UNAVAILABLE' });
}
