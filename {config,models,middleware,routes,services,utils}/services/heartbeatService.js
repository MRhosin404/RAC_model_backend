// services/heartbeatService.js
//
// Runs on the server every 30 s.
// 1. Calls ACUnit.markStaleDevicesOffline() — any device whose lastHeartbeat
//    is older than HEARTBEAT_TIMEOUT_SECONDS is flipped to isOnline=false.
// 2. Broadcasts an 'DEVICE_STATUS_CHANGED' event to all connected WebSocket
//    clients so React dashboards update instantly (red offline badge).

const ACUnit = require('../models/ACUnit');

let wss = null; // set via init()

const CHECK_INTERVAL_MS = 30_000; // 30 seconds

// ── Broadcast helpers ─────────────────────────────────────────
const broadcast = (data) => {
  if (!wss) return;
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === 1 /* OPEN */) {
      client.send(msg);
    }
  });
};

// ── Core check ────────────────────────────────────────────────
const checkHeartbeats = async () => {
  try {
    const timeout = parseInt(process.env.HEARTBEAT_TIMEOUT_SECONDS, 10) || 45;
    const markedOffline = await ACUnit.markStaleDevicesOffline(timeout);

    if (markedOffline > 0) {
      console.log(`[HeartbeatService] Marked ${markedOffline} device(s) offline.`);
      broadcast({ type: 'DEVICE_STATUS_CHANGED', payload: { markedOffline } });
    }
  } catch (err) {
    console.error('[HeartbeatService] Error:', err.message);
  }
};

// ── Init — call once from server.js after wss is ready ────────
const init = (webSocketServer) => {
  wss = webSocketServer;
  const timer = setInterval(checkHeartbeats, CHECK_INTERVAL_MS);
  console.log(`✅ HeartbeatService started (interval: ${CHECK_INTERVAL_MS / 1000}s)`);
  // Expose broadcast so route handlers can also push real-time updates
  return { timer, broadcast };
};

module.exports = { init, broadcast };
