// models/ACUnit.js  — Updated with electrical metrics + consumption tracking
const mongoose = require('mongoose');

const CommandSchema = new mongoose.Schema({
  type:  { type: String, enum: ['POWER','TEMPERATURE','MODE','FAN_SPEED','SWING','TURBO','ENERGY_SAVER'], required: true },
  value: { type: mongoose.Schema.Types.Mixed, required: true },
  enqueuedAt: { type: Date, default: Date.now },
  executedAt: { type: Date },
  status: { type: String, enum: ['pending','sent','executed','failed'], default: 'pending' },
}, { _id: true });

const ACStateSchema = new mongoose.Schema({
  power:       { type: Boolean, default: false },
  temperature: { type: Number, default: 24, min: 16, max: 30 },
  mode:        { type: String, enum: ['cool','heat','dry','fan','auto'], default: 'cool' },
  fanSpeed:    { type: String, enum: ['auto','low','medium','high'], default: 'auto' },
  swing:       { type: Boolean, default: false },
  turbo:       { type: Boolean, default: false },
  energySaver: { type: Boolean, default: false },
}, { _id: false });

// ── Extended sensor data — includes ESP8266 + PZEM-004T readings ──
const SensorDataSchema = new mongoose.Schema({
  // DHT22
  roomTemperature: { type: Number },
  roomHumidity:    { type: Number },
  // PZEM-004T electrical sensor
  voltage:     { type: Number },   // V
  current:     { type: Number },   // A
  frequency:   { type: Number },   // Hz
  powerWatts:  { type: Number },   // W (real-time)
  powerFactor: { type: Number },   // 0-1
  // Accumulated energy
  energyToday: { type: Number, default: 0 },  // kWh today
  energyMonth: { type: Number, default: 0 },  // kWh this month
  energyTotal: { type: Number, default: 0 },  // kWh all time
  recordedAt:  { type: Date, default: Date.now },
}, { _id: false });

// ── Hourly consumption snapshot for charts ─────────────────────
const ConsumptionLogSchema = new mongoose.Schema({
  timestamp:  { type: Date, default: Date.now },
  powerWatts: { type: Number, default: 0 },
  energyKwh:  { type: Number, default: 0 },
  costUsd:    { type: Number, default: 0 },
  tempC:      { type: Number },
}, { _id: false });

const ACUnitSchema = new mongoose.Schema({
  name:     { type: String, required: true, trim: true, maxlength: 60 },
  location: { type: String, trim: true },
  brand:    { type: String, trim: true },
  owner:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  deviceId: { type: String, unique: true, sparse: true, trim: true },
  apiKey:   { type: String, unique: true, sparse: true, select: false },

  // Card display variant
  cardVariant: { type: String, enum: ['simple','extended'], default: 'simple' },
  hasTurbo:    { type: Boolean, default: false },
  hasEnergy:   { type: Boolean, default: false },
  showFanSpeed:{ type: Boolean, default: false },
  runtime:     { type: String, default: '0h 0m' },

  desiredState:  { type: ACStateSchema,  default: () => ({}) },
  reportedState: { type: ACStateSchema,  default: () => ({}) },
  sensorData:    { type: SensorDataSchema, default: () => ({}) },
  commandQueue:  { type: [CommandSchema],  default: [] },

  // ── Consumption log — max 720 entries (30 days hourly) ────────
  consumptionLog: { type: [ConsumptionLogSchema], default: [] },

  // ── Aggregated stats ──────────────────────────────────────────
  stats: {
    totalRuntimeMinutes: { type: Number, default: 0 },
    totalEnergyKwh:      { type: Number, default: 0 },
    totalCostUsd:        { type: Number, default: 0 },
    lastResetDate:       { type: Date, default: Date.now },
  },

  lastHeartbeat: { type: Date },
  isOnline:      { type: Boolean, default: false },
  isActive:      { type: Boolean, default: true },
}, {
  timestamps: true,
  toJSON:  { virtuals: true },
  toObject:{ virtuals: true },
});

ACUnitSchema.index({ owner: 1, isActive: 1 });
ACUnitSchema.index({ lastHeartbeat: 1 });

ACUnitSchema.virtual('pendingCommandCount').get(function () {
  return this.commandQueue.filter(c => c.status === 'pending').length;
});

ACUnitSchema.methods.enqueueCommand = function (type, value) {
  this.commandQueue.push({ type, value, status: 'pending' });
  return this.save();
};

ACUnitSchema.methods.recordHeartbeat = function () {
  this.lastHeartbeat = new Date();
  this.isOnline      = true;
  return this.save();
};

ACUnitSchema.statics.markStaleDevicesOffline = async function (timeoutSeconds) {
  const cutoff = new Date(Date.now() - timeoutSeconds * 1000);
  const result = await this.updateMany(
    { isOnline: true, lastHeartbeat: { $lt: cutoff } },
    { $set: { isOnline: false } }
  );
  return result.modifiedCount;
};

module.exports = mongoose.model('ACUnit', ACUnitSchema);
