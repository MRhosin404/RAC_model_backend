// routes/esp.js  — All endpoints consumed by physical ESP8266 devices
//
// Every request MUST include: x-device-api-key header
// Optional:                   x-device-id header (ESP chip ID / MAC)
//
// Typical ESP poll cycle (every 5 s):
//   1. GET  /api/esp/state/:unitId        → fetch desired state + pending commands
//   2. POST /api/esp/sensor/:unitId       → push DHT22 room temp/humidity
//   3. POST /api/esp/heartbeat/:unitId    → record device is alive
//   4. POST /api/esp/ack/:unitId          → mark commands as executed

const express    = require('express');
const router     = express.Router();
const ACUnit     = require('../models/ACUnit');
const deviceAuth = require('../middleware/deviceAuth');
const { broadcast } = require('../services/heartbeatService');

// All ESP routes require device auth
router.use(deviceAuth);

// ── GET /api/esp/units ────────────────────────────────────────
// @desc    List ALL active units (used during device linking — ESP shows
//          this list on its captive portal so the user can pick one)
// @access  Device
router.get('/units', async (req, res, next) => {
  try {
    const units = await ACUnit.find({ isActive: true })
      .select('_id name location brand owner isOnline')
      .populate('owner', 'name')
      .sort({ name: 1 });

    // Return a lightweight payload optimised for ESP memory
    const payload = units.map(u => ({
      id:       u._id,
      name:     u.name,
      location: u.location || '',
      owner:    u.owner?.name || '',
      linked:   !!u.deviceId, // already linked to a physical device?
    }));

    res.status(200).json({ success: true, count: payload.length, units: payload });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/esp/link ────────────────────────────────────────
// @desc    Link this physical device to a specific Unit_ID.
//          ESP calls this after the user selects a unit on the captive portal.
//          Saves deviceId into the unit document.
// @access  Device
router.post('/link', async (req, res, next) => {
  try {
    const { unitId } = req.body;
    const deviceId   = req.headers['x-device-id'];

    if (!unitId)   return res.status(400).json({ success: false, message: 'unitId is required' });
    if (!deviceId) return res.status(400).json({ success: false, message: 'x-device-id header is required' });

    // Ensure no other unit is already linked to this deviceId
    await ACUnit.updateMany({ deviceId }, { $unset: { deviceId: '' } });

    const unit = await ACUnit.findByIdAndUpdate(
      unitId,
      { deviceId, isOnline: true, lastHeartbeat: new Date() },
      { new: true, runValidators: false }
    ).select('_id name location desiredState');

    if (!unit) return res.status(404).json({ success: false, message: 'Unit not found' });

    broadcast({ type: 'DEVICE_LINKED', unitId: unit._id.toString(), deviceId });

    res.status(200).json({
      success:      true,
      message:      `Device linked to unit: ${unit.name}`,
      unitId:       unit._id,
      desiredState: unit.desiredState,
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/esp/state/:unitId ────────────────────────────────
// @desc    Fetch desired state AND drain the pending command queue.
//          This is the main poll endpoint. The ESP calls this every 5 s.
//          Returns the full desired state + any pending commands.
// @access  Device
router.get('/state/:unitId', async (req, res, next) => {
  try {
    const unit = await ACUnit.findById(req.params.unitId).select(
      'desiredState commandQueue isOnline'
    );

    if (!unit) return res.status(404).json({ success: false, message: 'Unit not found' });

    // Filter to pending commands only
    const pendingCommands = unit.commandQueue.filter(c => c.status === 'pending');

    // Mark them as 'sent' so a duplicate poll doesn't re-send the same command
    // The ESP must ACK (POST /esp/ack) to mark them 'executed'
    await ACUnit.updateOne(
      { _id: unit._id },
      {
        $set: {
          'commandQueue.$[elem].status': 'sent',
        },
      },
      {
        arrayFilters: [{ 'elem.status': 'pending' }],
        timestamps:   false,
      }
    );

    res.status(200).json({
      success:      true,
      desiredState: unit.desiredState,
      commands:     pendingCommands.map(c => ({
        id:    c._id,
        type:  c.type,
        value: c.value,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/esp/sensor/:unitId ──────────────────────────────
// @desc    Push latest DHT22 sensor reading (room temp + humidity)
//          ESP calls this every poll cycle.
// @access  Device
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
            roomTemperature,
            roomHumidity: roomHumidity ?? null,
            recordedAt:   new Date(),
          },
        },
      },
      { new: false, timestamps: false }
    );

    if (!unit) return res.status(404).json({ success: false, message: 'Unit not found' });

    // Broadcast sensor update to all React clients
    broadcast({
      type:    'SENSOR_UPDATE',
      unitId:  req.params.unitId,
      payload: { roomTemperature, roomHumidity },
    });

    res.status(200).json({ success: true, message: 'Sensor data recorded' });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/esp/heartbeat/:unitId ──────────────────────────
// @desc    Ping endpoint — ESP calls this every 30 s to prove it's alive.
//          Updates lastHeartbeat + sets isOnline=true.
//          HeartbeatService marks devices offline if this stops arriving.
// @access  Device
router.post('/heartbeat/:unitId', async (req, res, next) => {
  try {
    const unit = await ACUnit.findById(req.params.unitId);
    if (!unit) return res.status(404).json({ success: false, message: 'Unit not found' });

    const wasOffline = !unit.isOnline;
    await unit.recordHeartbeat();

    // If device just came back online, broadcast recovery event
    if (wasOffline) {
      broadcast({ type: 'DEVICE_ONLINE', unitId: unit._id.toString() });
    }

    res.status(200).json({ success: true, timestamp: new Date().toISOString() });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/esp/ack/:unitId ─────────────────────────────────
// @desc    ESP confirms it has executed the listed command IDs.
//          Marks them as 'executed' in the queue and updates reportedState.
// @access  Device
router.post('/ack/:unitId', async (req, res, next) => {
  try {
    const { executedCommandIds, reportedState } = req.body;

    if (!Array.isArray(executedCommandIds) || executedCommandIds.length === 0) {
      return res.status(400).json({ success: false, message: 'executedCommandIds array is required' });
    }

    const updatePayload = {
      $set: {
        'commandQueue.$[elem].status':     'executed',
        'commandQueue.$[elem].executedAt': new Date(),
      },
    };

    await ACUnit.updateOne(
      { _id: req.params.unitId },
      updatePayload,
      { arrayFilters: [{ 'elem._id': { $in: executedCommandIds } }], timestamps: false }
    );

    // Optionally sync reported state
    if (reportedState) {
      await ACUnit.findByIdAndUpdate(req.params.unitId, { $set: { reportedState } });
    }

    broadcast({
      type:    'COMMANDS_EXECUTED',
      unitId:  req.params.unitId,
      payload: { executedCommandIds, reportedState },
    });

    res.status(200).json({ success: true, message: 'Commands acknowledged' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
