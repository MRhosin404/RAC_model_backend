// models/ACUnit.js
const mongoose = require('mongoose');

// ── Sub-schema: a single pending command ─────────────────────
// Commands survive device outages via this queue.
const CommandSchema = new mongoose.Schema(
  {
    type: {
      type:     String,
      enum:     ['POWER', 'TEMPERATURE', 'MODE', 'FAN_SPEED', 'SWING'],
      required: true,
    },
    value: {
      type:     mongoose.Schema.Types.Mixed, // Boolean | Number | String
      required: true,
    },
    enqueuedAt:  { type: Date, default: Date.now },
    executedAt:  { type: Date },
    status: {
      type:    String,
      enum:    ['pending', 'sent', 'executed', 'failed'],
      default: 'pending',
    },
  },
  { _id: true }
);

// ── Sub-schema: the AC operating state ───────────────────────
const ACStateSchema = new mongoose.Schema(
  {
    power: {
      type:    Boolean,
      default: false,
    },
    temperature: {
      type:    Number,
      default: 24,
      min:     [16, 'Temperature cannot be below 16°C'],
      max:     [30, 'Temperature cannot exceed 30°C'],
    },
    mode: {
      type:    String,
      enum:    ['cool', 'heat', 'dry', 'fan', 'auto'],
      default: 'cool',
    },
    fanSpeed: {
      type:    String,
      enum:    ['auto', 'low', 'medium', 'high'],
      default: 'auto',
    },
    swing: {
      type:    Boolean,
      default: false,
    },
  },
  { _id: false }
);

// ── Sub-schema: latest sensor reading from the room ──────────
const SensorDataSchema = new mongoose.Schema(
  {
    roomTemperature: { type: Number },   // °C from DHT22
    roomHumidity:    { type: Number },   // % from DHT22
    recordedAt:      { type: Date, default: Date.now },
  },
  { _id: false }
);

// ── Main ACUnit schema ────────────────────────────────────────
const ACUnitSchema = new mongoose.Schema(
  {
    // ── Identity ─────────────────────────────────────────────
    name: {
      type:      String,
      required:  [true, 'AC unit name is required'],
      trim:      true,
      maxlength: [60, 'Name cannot exceed 60 characters'],
    },
    location: {
      type:  String,
      trim:  true,
      maxlength: [100, 'Location cannot exceed 100 characters'],
    },
    // Human-readable note about the brand / IR code set
    brand: {
      type: String,
      trim: true,
    },

    // ── Ownership ────────────────────────────────────────────
    owner: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'User',
      required: [true, 'An AC unit must have an owner'],
      index:    true,
    },

    // ── Physical device link ──────────────────────────────────
    // Set by ESP8266 during the linking step (POST /api/esp/link)
    deviceId: {
      type:   String,
      unique: true,
      sparse: true, // allows multiple documents with null deviceId
      trim:   true,
    },
    // API key scoped to this specific unit (generated on creation)
    apiKey: {
      type:   String,
      unique: true,
      sparse: true,
      select: false, // never leak in list endpoints
    },

    // ── Current desired state (what the cloud wants) ──────────
    desiredState: {
      type:    ACStateSchema,
      default: () => ({}),
    },

    // ── Reported state (what ESP last confirmed) ──────────────
    reportedState: {
      type:    ACStateSchema,
      default: () => ({}),
    },

    // ── Latest sensor data ────────────────────────────────────
    sensorData: {
      type:    SensorDataSchema,
      default: () => ({}),
    },

    // ── Command queue ─────────────────────────────────────────
    // React UI pushes commands here; ESP drains them on next poll.
    commandQueue: {
      type:    [CommandSchema],
      default: [],
    },

    // ── Heartbeat / connectivity ──────────────────────────────
    lastHeartbeat: {
      type: Date,
    },
    isOnline: {
      type:    Boolean,
      default: false,
    },

    // ── Soft delete ───────────────────────────────────────────
    isActive: {
      type:    Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
    toJSON:     { virtuals: true },
    toObject:   { virtuals: true },
  }
);

// ── Indexes ───────────────────────────────────────────────────
// deviceId already has unique:true — no extra declaration needed.
ACUnitSchema.index({ owner: 1, isActive: 1 });
ACUnitSchema.index({ lastHeartbeat: 1 });

// ── Virtual: pending command count ────────────────────────────
ACUnitSchema.virtual('pendingCommandCount').get(function () {
  return this.commandQueue.filter(c => c.status === 'pending').length;
});

// ── Instance method: enqueue a command ───────────────────────
ACUnitSchema.methods.enqueueCommand = function (type, value) {
  this.commandQueue.push({ type, value, status: 'pending' });
  return this.save();
};

// ── Instance method: mark heartbeat received ──────────────────
ACUnitSchema.methods.recordHeartbeat = function () {
  this.lastHeartbeat = new Date();
  this.isOnline      = true;
  return this.save();
};

// ── Static: mark stale devices offline ───────────────────────
// Called by HeartbeatService on a schedule (every 30 s).
ACUnitSchema.statics.markStaleDevicesOffline = async function (timeoutSeconds) {
  const cutoff = new Date(Date.now() - timeoutSeconds * 1000);
  const result = await this.updateMany(
    { isOnline: true, lastHeartbeat: { $lt: cutoff } },
    { $set: { isOnline: false } }
  );
  return result.modifiedCount;
};

module.exports = mongoose.model('ACUnit', ACUnitSchema);
