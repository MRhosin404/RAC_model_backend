// routes/esp.js  — ESP8266 endpoints (updated with electrical metrics)
const express    = require('express');
const router     = express.Router();
const ACUnit     = require('../models/ACUnit');
const deviceAuth = require('../middleware/deviceAuth');
const { broadcast } = require('../services/heartbeatService');

const COST_RATE = 0.136; // USD per kWh (configurable)

router.use(deviceAuth);

// GET /api/esp/units — list all units for captive portal linking
router.get('/units', async (req, res, next) => {
  try {
    const units = await ACUnit.find({ isActive: true })
      .select('_id name location brand owner isOnline')
      .populate('owner', 'name').sort({ name: 1 });
    res.status(200).json({
      success: true,
      units: units.map(u => ({
        id: u._id, name: u.name, location: u.location || '',
        owner: u.owner?.name || '', linked: !!u.deviceId,
      })),
    });
  } catch (err) { next(err); }
});

// POST /api/esp/link — link device to unit
router.post('/link', async (req, res, next) => {
  try {
    const { unitId } = req.body;
    const deviceId   = req.headers['x-device-id'];
    if (!unitId)   return res.status(400).json({ success:false, message:'unitId required' });
    if (!deviceId) return res.status(400).json({ success:false, message:'x-device-id header required' });
    await ACUnit.updateMany({ deviceId }, { $unset: { deviceId:'' } });
    const unit = await ACUnit.findByIdAndUpdate(unitId,
      { deviceId, isOnline: true, lastHeartbeat: new Date() },
      { new: true }).select('_id name desiredState');
    if (!unit) return res.status(404).json({ success:false, message:'Unit not found' });
    broadcast({ type:'DEVICE_LINKED', unitId: unit._id.toString(), deviceId });
    res.status(200).json({ success:true, message:`Linked to: ${unit.name}`, unitId: unit._id, desiredState: unit.desiredState });
  } catch (err) { next(err); }
});

// GET /api/esp/state/:unitId — poll desired state + pending commands
router.get('/state/:unitId', async (req, res, next) => {
  try {
    const unit = await ACUnit.findById(req.params.unitId).select('desiredState commandQueue isOnline');
    if (!unit) return res.status(404).json({ success:false, message:'Unit not found' });
    const pending = unit.commandQueue.filter(c => c.status === 'pending');
    await ACUnit.updateOne({ _id: unit._id },
      { $set: { 'commandQueue.$[e].status': 'sent' } },
      { arrayFilters:[{ 'e.status':'pending' }], timestamps:false }
    );
    res.status(200).json({ success:true, desiredState: unit.desiredState, commands: pending.map(c => ({ id:c._id, type:c.type, value:c.value })) });
  } catch (err) { next(err); }
});

// POST /api/esp/sensor/:unitId — push DHT22 + PZEM-004T readings
router.post('/sensor/:unitId', async (req, res, next) => {
  try {
    const {
      // DHT22
      roomTemperature, roomHumidity,
      // PZEM-004T electrical
      voltage, current, frequency, powerWatts, powerFactor,
      // Accumulated
      energyToday, energyMonth, energyTotal,
    } = req.body;

    if (roomTemperature === undefined && voltage === undefined) {
      return res.status(400).json({ success:false, message:'At least one sensor reading required' });
    }

    const now     = new Date();
    const costUsd = energyToday != null ? +(energyToday * COST_RATE).toFixed(4) : 0;

    // Build sensor data update
    const sensorUpdate = { recordedAt: now };
    if (roomTemperature != null) sensorUpdate.roomTemperature = roomTemperature;
    if (roomHumidity    != null) sensorUpdate.roomHumidity    = roomHumidity;
    if (voltage         != null) sensorUpdate.voltage         = voltage;
    if (current         != null) sensorUpdate.current         = current;
    if (frequency       != null) sensorUpdate.frequency       = frequency;
    if (powerWatts      != null) sensorUpdate.powerWatts      = powerWatts;
    if (powerFactor     != null) sensorUpdate.powerFactor     = powerFactor;
    if (energyToday     != null) sensorUpdate.energyToday     = energyToday;
    if (energyMonth     != null) sensorUpdate.energyMonth     = energyMonth;
    if (energyTotal     != null) sensorUpdate.energyTotal     = energyTotal;

    // Push hourly snapshot to consumption log (keep last 720)
    const logEntry = {
      timestamp: now, powerWatts: powerWatts || 0,
      energyKwh: energyToday || 0, costUsd, tempC: roomTemperature,
    };

    await ACUnit.findByIdAndUpdate(req.params.unitId, {
      $set: { sensorData: sensorUpdate },
      $push: { consumptionLog: { $each: [logEntry], $slice: -720 } },
      $inc:  { 'stats.totalEnergyKwh': 0 }, // placeholder for future
    }, { timestamps: false });

    // Broadcast to all React dashboard clients
    broadcast({
      type:    'SENSOR_UPDATE',
      unitId:  req.params.unitId,
      payload: { roomTemperature, roomHumidity, voltage, current, frequency, powerWatts, powerFactor, energyToday, energyMonth, costUsd },
    });

    res.status(200).json({ success:true, message:'Sensor data recorded', costUsd });
  } catch (err) { next(err); }
});

// POST /api/esp/heartbeat/:unitId
router.post('/heartbeat/:unitId', async (req, res, next) => {
  try {
    const unit = await ACUnit.findById(req.params.unitId);
    if (!unit) return res.status(404).json({ success:false, message:'Unit not found' });
    const wasOffline = !unit.isOnline;
    await unit.recordHeartbeat();
    if (wasOffline) broadcast({ type:'DEVICE_ONLINE', unitId: unit._id.toString() });
    res.status(200).json({ success:true, timestamp: new Date().toISOString() });
  } catch (err) { next(err); }
});

// POST /api/esp/ack/:unitId — mark commands executed
router.post('/ack/:unitId', async (req, res, next) => {
  try {
    const { executedCommandIds, reportedState } = req.body;
    if (!Array.isArray(executedCommandIds) || !executedCommandIds.length) {
      return res.status(400).json({ success:false, message:'executedCommandIds required' });
    }
    await ACUnit.updateOne({ _id: req.params.unitId },
      { $set: { 'commandQueue.$[e].status':'executed', 'commandQueue.$[e].executedAt': new Date() } },
      { arrayFilters:[{ 'e._id':{ $in: executedCommandIds } }], timestamps:false }
    );
    if (reportedState) {
      await ACUnit.findByIdAndUpdate(req.params.unitId, { $set:{ reportedState } });
    }
    broadcast({ type:'COMMANDS_EXECUTED', unitId: req.params.unitId, payload:{ executedCommandIds, reportedState } });
    res.status(200).json({ success:true, message:'Acknowledged' });
  } catch (err) { next(err); }
});

// GET /api/esp/consumption/:unitId — full log for charts
router.get('/consumption/:unitId', async (req, res, next) => {
  try {
    const unit = await ACUnit.findById(req.params.unitId).select('consumptionLog sensorData stats name');
    if (!unit) return res.status(404).json({ success:false });
    res.status(200).json({ success:true, data: { log: unit.consumptionLog, sensorData: unit.sensorData, stats: unit.stats, name: unit.name } });
  } catch (err) { next(err); }
});

module.exports = router;
