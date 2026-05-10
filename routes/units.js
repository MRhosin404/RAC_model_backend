// routes/units.js  — React dashboard CRUD for Virtual AC Cards
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const ACUnit = require('../models/ACUnit');
const User = require('../models/User');
const { protect } = require('../middleware/protect');
const { broadcast } = require('../services/heartbeatService');

// All routes here require a valid JWT
router.use(protect);

// ── GET /api/units ────────────────────────────────────────────
// @desc    Get all AC units owned by the current user
// @access  Private
// routes/units.js  — replace the GET / route
router.get('/', async (req, res, next) => {
  try {
    const units = await ACUnit.find({ owner: req.user.id, isActive: true })
      .select('-apiKey')
      .lean()
      .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      count: units.length,
      data: units,
    });
  } catch (err) {
    console.error('❌ /units error:', err.message);
    next(err);
  }
});

// ── GET /api/units/:id ────────────────────────────────────────
// @desc    Get a single AC unit (includes queue for dashboard display)
// @access  Private
router.get('/:id', async (req, res, next) => {
  try {
    const unit = await ACUnit.findOne({ _id: req.params.id, owner: req.user.id, isActive: true });

    if (!unit) {
      return res.status(404).json({ success: false, message: 'AC unit not found' });
    }

    res.status(200).json({ success: true, data: unit });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/units ───────────────────────────────────────────
// @desc    Create a new Virtual AC Card
// @access  Private
router.post('/', async (req, res, next) => {
  try {
    const { name, location, brand } = req.body;

    // Generate a unique per-device API key at creation time
    const apiKey = 'esp_' + crypto.randomBytes(24).toString('hex');

    const unit = await ACUnit.create({
      name,
      location,
      brand,
      owner: req.user.id,
      apiKey,
    });

    // Add to user's unit list
    await User.findByIdAndUpdate(req.user.id, { $push: { acUnits: unit._id } });

    // Return unit WITH apiKey (the only time it's sent — user must note it for flashing)
    res.status(201).json({
      success: true,
      data: unit,
      apiKey,  // explicitly surface it once
      message: 'Store this API key — it will not be shown again.',
    });
  } catch (err) {
    next(err);
  }
});

// ── PUT /api/units/:id/state ──────────────────────────────────
// @desc    Update desired state AND enqueue a command for the ESP
// @access  Private
router.put('/:id/state', async (req, res, next) => {
  try {
    const { power, temperature, mode, fanSpeed, swing } = req.body;

    const unit = await ACUnit.findOne({ _id: req.params.id, owner: req.user.id, isActive: true });
    if (!unit) {
      return res.status(404).json({ success: false, message: 'AC unit not found' });
    }

    // ── Update desired state fields that were provided ────────
    if (power !== undefined) unit.desiredState.power = power;
    if (temperature !== undefined) unit.desiredState.temperature = temperature;
    if (mode !== undefined) unit.desiredState.mode = mode;
    if (fanSpeed !== undefined) unit.desiredState.fanSpeed = fanSpeed;
    if (swing !== undefined) unit.desiredState.swing = swing;

    // ── Enqueue commands for each changed field ────────────────
    // The ESP drains this queue on the next poll cycle.
    if (power !== undefined) unit.commandQueue.push({ type: 'POWER', value: power, status: 'pending' });
    if (temperature !== undefined) unit.commandQueue.push({ type: 'TEMPERATURE', value: temperature, status: 'pending' });
    if (mode !== undefined) unit.commandQueue.push({ type: 'MODE', value: mode, status: 'pending' });
    if (fanSpeed !== undefined) unit.commandQueue.push({ type: 'FAN_SPEED', value: fanSpeed, status: 'pending' });
    if (swing !== undefined) unit.commandQueue.push({ type: 'SWING', value: swing, status: 'pending' });

    await unit.save();

    // ── WebSocket push to dashboard clients ───────────────────
    broadcast({
      type: 'STATE_UPDATED',
      unitId: unit._id.toString(),
      payload: unit.desiredState,
    });

    res.status(200).json({ success: true, data: unit.desiredState });
  } catch (err) {
    next(err);
  }
});

// ── PUT /api/units/:id ────────────────────────────────────────
// @desc    Update unit metadata (name, location, brand)
// @access  Private
router.put('/:id', async (req, res, next) => {
  try {
    const allowedUpdates = { name: req.body.name, location: req.body.location, brand: req.body.brand };
    // Strip undefined keys
    Object.keys(allowedUpdates).forEach(k => allowedUpdates[k] === undefined && delete allowedUpdates[k]);

    const unit = await ACUnit.findOneAndUpdate(
      { _id: req.params.id, owner: req.user.id, isActive: true },
      allowedUpdates,
      { new: true, runValidators: true }
    );

    if (!unit) return res.status(404).json({ success: false, message: 'AC unit not found' });
    res.status(200).json({ success: true, data: unit });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/units/:id ─────────────────────────────────────
// @desc    Soft-delete a unit (sets isActive=false)
// @access  Private
router.delete('/:id', async (req, res, next) => {
  try {
    const unit = await ACUnit.findOneAndUpdate(
      { _id: req.params.id, owner: req.user.id },
      { isActive: false },
      { new: true }
    );

    if (!unit) return res.status(404).json({ success: false, message: 'AC unit not found' });

    await User.findByIdAndUpdate(req.user.id, { $pull: { acUnits: unit._id } });

    res.status(200).json({ success: true, message: 'Unit deleted' });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/units/:id/queue ──────────────────────────────────
// @desc    View the command queue for a unit (debug / dashboard)
// @access  Private
router.get('/:id/queue', async (req, res, next) => {
  try {
    const unit = await ACUnit.findOne({ _id: req.params.id, owner: req.user.id, isActive: true })
      .select('commandQueue desiredState isOnline lastHeartbeat');

    if (!unit) return res.status(404).json({ success: false, message: 'AC unit not found' });

    res.status(200).json({
      success: true,
      isOnline: unit.isOnline,
      lastHeartbeat: unit.lastHeartbeat,
      pending: unit.commandQueue.filter(c => c.status === 'pending'),
      history: unit.commandQueue.filter(c => c.status !== 'pending').slice(-20),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
