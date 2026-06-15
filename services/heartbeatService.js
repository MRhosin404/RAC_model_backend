// services/heartbeatService.js
//
// Two background jobs run here:
//
// 1. checkHeartbeats()  — every 30s
//    Marks devices OFFLINE if no heartbeat received within timeout.
//    Broadcasts DEVICE_STATUS_CHANGED to all WebSocket clients.
//
// 2. cleanCommandQueues() — every 5s
//    If any unit's commandQueue has MORE THAN 5 items, clear it completely.
//    Reason: ESP8266 has very low RAM (~50KB heap). A large queue payload
//    causes the HTTP response to be too big → ESP hangs or crashes.
//    Clearing the queue forces a clean state so the ESP can recover.

const ACUnit = require('../models/ACUnit');

let wss = null;

// ── Broadcast to all connected WebSocket clients ──────────────
const broadcast = (data) => {
  if (!wss) return;
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === 1 /* OPEN */) {
      client.send(msg);
    }
  });
};

// ── Job 1: Mark stale devices offline (every 30s) ─────────────
const checkHeartbeats = async () => {
  try {
    const timeout = parseInt(process.env.HEARTBEAT_TIMEOUT_SECONDS, 10) || 45;
    const markedOffline = await ACUnit.markStaleDevicesOffline(timeout);

    if (markedOffline > 0) {
      console.log(`[Heartbeat] Marked ${markedOffline} device(s) offline`);
      broadcast({ type: 'DEVICE_STATUS_CHANGED', payload: { markedOffline } });
    }
  } catch (err) {
    console.error('[Heartbeat] Error:', err.message);
  }
};

// ── Job 2: Clear oversized command queues (every 5s) ──────────
//
// If commandQueue.length > 5 → set commandQueue = []
//
// Why clear instead of trim?
//   Trimming (keeping newest 5) could still confuse the ESP because
//   it might have already received some of those commands. A full
//   clear forces both sides to resync cleanly from desiredState.
//
const MAX_QUEUE_SIZE = 5;

const cleanCommandQueues = async () => {
  try {
    // MongoDB query: find units where commandQueue array index [5] exists
    // (meaning the array has at least 6 elements → length > 5)
    const result = await ACUnit.updateMany(
      {
        $expr: { $gt: [{ $size: '$commandQueue' }, MAX_QUEUE_SIZE] },
      },
      {
        $set: { commandQueue: [] },
      },
      { timestamps: false }
    );

    if (result.modifiedCount > 0) {
      console.log(
        `[QueueCleaner] ⚠️  Cleared commandQueue on ${result.modifiedCount} unit(s) ` +
        `(was > ${MAX_QUEUE_SIZE} items — prevents ESP RAM overflow)`
      );

      // Tell React dashboards that queues were cleared
      broadcast({
        type: 'QUEUE_CLEARED',
        payload: { count: result.modifiedCount, reason: 'overflow_protection' },
      });
    }
  } catch (err) {
    console.error('[QueueCleaner] Error:', err.message);
  }
};

// ── Init — called once from server.js after WSS is ready ──────
const init = (webSocketServer) => {
  wss = webSocketServer;

  // Job 1: heartbeat check every 30 seconds
  const heartbeatTimer = setInterval(checkHeartbeats, 30_000);

  // Job 2: queue cleanup every 5 seconds
  const cleanerTimer = setInterval(cleanCommandQueues, 5_000);

  console.log('✅ HeartbeatService started   (interval: 30s)');
  console.log('✅ QueueCleaner started       (interval: 5s, max queue: 5)');

  return { heartbeatTimer, cleanerTimer, broadcast };
};

module.exports = { init, broadcast };
