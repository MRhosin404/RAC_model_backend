// routes/esp.js — ESP8266 endpoints
//
// ✅ NO AUTH REQUIRED — ESP8266 accesses these routes directly
//    No x-device-api-key needed. Just use the unitId.
//
// Poll cycle (every 5s):
//   GET  /api/esp/state/:unitId      → fetch desired state + commands
//   POST /api/esp/heartbeat/:unitId  → prove device is alive
//   POST /api/esp/sensor/:unitId     → push DHT22 data
//   POST /api/esp/ack/:unitId        → confirm commands executed
//   GET  /api/esp/units              → list all units (setup portal)
//   POST /api/esp/link               → link device to unit

const express = require('express');
const router = express.Router();
const ACUnit = require('../models/ACUnit');
const { broadcast } = require('../services/heartbeatService');

// ── GET /api/esp/units ────────────────────────────────────────
// List all active units for the setup portal (no auth needed)
router.get('/units', async (req, res, next) => {
  try {
    const units = await ACUnit.find({ isActive: true })
      .populate('owner', 'name')
      .sort({ name: 1 });

    res.status(200).json(units);
  } catch (err) {
    next(err);
  }
});

// ── POST /api/esp/link ────────────────────────────────────────
// Link this device to a unit. Called from setup portal.
// Body: { unitId: "..." }
// Optional header: x-device-id (ESP chip ID)
router.post('/link', async (req, res, next) => {
  try {
    const { unitId } = req.body;

    if (!unitId) {
      return res.status(400).json({ success: false, message: 'unitId is required' });
    }

    // Use x-device-id header if sent, otherwise generate one from unitId
    const deviceId = req.headers['x-device-id'] || ('esp-' + unitId.slice(-8));

    // Unlink this deviceId from any other unit first
    await ACUnit.updateMany({ deviceId }, { $unset: { deviceId: '' } });

    const unit = await ACUnit.findByIdAndUpdate(
      unitId,
      { deviceId, isOnline: true, lastHeartbeat: new Date() },
      { new: true, runValidators: false }
    ).select('_id name location desiredState');

    if (!unit) {
      return res.status(404).json({ success: false, message: 'Unit not found' });
    }

    broadcast({ type: 'DEVICE_LINKED', unitId: unit._id.toString(), deviceId });

    res.status(200).json({
      success: true,
      message: `Linked to: ${unit.name}`,
      unitId: unit._id,
      deviceId: deviceId,
      desiredState: unit.desiredState,
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/esp/state/:unitId ────────────────────────────────
// Main poll endpoint — returns desired state + pending commands.
// Only sends "pending" commands. Marks them "sent" after sending.
// ⚠️  commandQueue is auto-cleared by the server if it grows > 5 items.
router.get('/state/:unitId', async (req, res, next) => {
  try {
    const unit = await ACUnit.findById(req.params.unitId)
      .select('desiredState commandQueue isOnline');

    if (!unit) {
      return res.status(404).json({ success: false, message: 'Unit not found' });
    }

    // Only take pending commands
    const pendingCommands = unit.commandQueue.filter(c => c.status === 'pending');

    // Mark pending → sent (so next poll doesn't re-send the same ones)
    if (pendingCommands.length > 0) {
      await ACUnit.updateOne(
        { _id: unit._id },
        { $set: { 'commandQueue.$[elem].status': 'sent' } },
        { arrayFilters: [{ 'elem.status': 'pending' }], timestamps: false }
      );
    }

    res.status(200).json({
      success: true,
      desiredState: unit.desiredState,
      commands: pendingCommands.map(c => ({
        id: c._id,
        type: c.type,
        value: c.value,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/esp/sensor/:unitId ──────────────────────────────
// Push DHT22 sensor data. roomTemperature is required.
// Body: { roomTemperature, roomHumidity }
router.post('/sensor/:unitId', async (req, res, next) => {
  try {
    const { roomTemperature, roomHumidity } = req.body;

    if (roomTemperature === undefined) {
      return res.status(400).json({ success: false, message: 'roomTemperature is required' });
    }

    const unit = await ACUnit.findByIdAndUpdate(
      req.params.unitId,
      {
        $set: {
          sensorData: {
            roomTemperature: parseFloat(roomTemperature),
            roomHumidity: roomHumidity != null ? parseFloat(roomHumidity) : null,
            recordedAt: new Date(),
          },
        },
      },
      { new: false, timestamps: false }
    );

    if (!unit) {
      return res.status(404).json({ success: false, message: 'Unit not found' });
    }

    broadcast({
      type: 'SENSOR_UPDATE',
      unitId: req.params.unitId,
      payload: { roomTemperature: parseFloat(roomTemperature), roomHumidity },
    });

    res.status(200).json({ success: true, message: 'Sensor data recorded' });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/esp/heartbeat/:unitId ──────────────────────────
// ESP calls this every 30s. If missed for 45s → marked offline.
router.post('/heartbeat/:unitId', async (req, res, next) => {
  try {
    const unit = await ACUnit.findById(req.params.unitId);

    if (!unit) {
      return res.status(404).json({ success: false, message: 'Unit not found' });
    }

    const wasOffline = !unit.isOnline;
    await unit.recordHeartbeat();

    if (wasOffline) {
      broadcast({ type: 'DEVICE_ONLINE', unitId: unit._id.toString() });
    }

    res.status(200).json({ success: true, timestamp: new Date().toISOString() });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/esp/ack/:unitId ─────────────────────────────────
// ESP confirms commands were executed.
// Body: { executedCommandIds: ["id1","id2"...], reportedState: {...} }
router.post('/ack/:unitId', async (req, res, next) => {
  try {
    const { executedCommandIds, reportedState } = req.body;

    if (!Array.isArray(executedCommandIds) || executedCommandIds.length === 0) {
      return res.status(400).json({ success: false, message: 'executedCommandIds array required' });
    }

    // Mark commands as executed
    await ACUnit.updateOne(
      { _id: req.params.unitId },
      {
        $set: {
          'commandQueue.$[elem].status': 'executed',
          'commandQueue.$[elem].executedAt': new Date(),
        },
      },
      {
        arrayFilters: [{ 'elem._id': { $in: executedCommandIds } }],
        timestamps: false,
      }
    );

    // Sync reported state back if ESP sent it
    if (reportedState && typeof reportedState === 'object') {
      await ACUnit.findByIdAndUpdate(
        req.params.unitId,
        { $set: { reportedState } },
        { timestamps: false }
      );
    }

    broadcast({
      type: 'COMMANDS_EXECUTED',
      unitId: req.params.unitId,
      payload: { executedCommandIds, reportedState },
    });

    res.status(200).json({ success: true, message: 'Commands acknowledged' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;