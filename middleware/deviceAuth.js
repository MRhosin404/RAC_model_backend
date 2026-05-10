// middleware/deviceAuth.js  — API key auth for ESP8266 hardware requests
//
// Every request from a physical ESP8266 must include:
//   Header:  x-device-api-key: <DEVICE_API_KEY>
//
// Optionally, the ESP may also send:
//   Header:  x-device-id: <chip ID or MAC>
// This is attached to req.deviceId for use in route handlers.

const ACUnit = require('../models/ACUnit');

const deviceAuth = async (req, res, next) => {
  const incomingKey = req.headers['x-device-api-key'];
  const deviceId    = req.headers['x-device-id'] || null;

  if (!incomingKey) {
    return res.status(401).json({
      success: false,
      message: 'Missing x-device-api-key header',
    });
  }

  // ── Option A: global shared key (simpler, used in early dev) ──────────
  if (incomingKey === process.env.DEVICE_API_KEY) {
    req.deviceId = deviceId;
    return next();
  }

  // ── Option B: per-unit key (production — generated on unit creation) ──
  // We search the apiKey field which is normally hidden (select: false),
  // so we must explicitly re-select it here.
  try {
    const unit = await ACUnit.findOne({ apiKey: incomingKey }).select('+apiKey');
    if (!unit) {
      return res.status(401).json({ success: false, message: 'Invalid device API key' });
    }
    req.deviceId  = unit.deviceId || deviceId;
    req.linkedUnit = unit; // attach unit so route handlers can skip a DB lookup
    return next();
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Auth check failed' });
  }
};

module.exports = deviceAuth;
