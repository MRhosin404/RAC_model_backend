// models/User.js
const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const crypto   = require('crypto');

const UserSchema = new mongoose.Schema(
  {
    // ── Identity ──────────────────────────────────────────────
    name: {
      type:     String,
      required: [true, 'Name is required'],
      trim:     true,
      maxlength: [60, 'Name cannot exceed 60 characters'],
    },
    email: {
      type:      String,
      required:  [true, 'Email is required'],
      unique:    true,
      lowercase: true,
      trim:      true,
      match: [
        /^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,10})+$/,
        'Please enter a valid email address',
      ],
    },
    password: {
      type:      String,
      required:  [true, 'Password is required'],
      minlength: [8, 'Password must be at least 8 characters'],
      select:    false, // never returned in queries by default
    },

    // ── Role & access ─────────────────────────────────────────
    role: {
      type:    String,
      enum:    ['user', 'admin'],
      default: 'user',
    },

    // ── Owned AC units ────────────────────────────────────────
    // Populated via virtual from ACUnit.owner, but kept here for quick look-up
    acUnits: [{ type: mongoose.Schema.Types.ObjectId, ref: 'ACUnit' }],

    // ── Password reset ────────────────────────────────────────
    resetPasswordToken:   String,
    resetPasswordExpire:  Date,

    // ── Timestamps ────────────────────────────────────────────
    lastLogin: { type: Date },
  },
  {
    timestamps: true,   // createdAt + updatedAt
    toJSON:     { virtuals: true },
    toObject:   { virtuals: true },
  }
);

// ── Indexes ───────────────────────────────────────────────────
// Note: email has unique:true which already creates an index — no extra declaration needed.

// ── Pre-save: hash password ───────────────────────────────────
UserSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(12);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// ── Method: compare plain password ───────────────────────────
UserSchema.methods.matchPassword = async function (enteredPassword) {
  return bcrypt.compare(enteredPassword, this.password);
};

// ── Method: sign JWT ──────────────────────────────────────────
UserSchema.methods.getSignedJwt = function () {
  return jwt.sign(
    { id: this._id, role: this.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
};

// ── Method: generate password-reset token ────────────────────
UserSchema.methods.getResetPasswordToken = function () {
  const rawToken = crypto.randomBytes(20).toString('hex');
  // Store hashed version
  this.resetPasswordToken  = crypto.createHash('sha256').update(rawToken).digest('hex');
  this.resetPasswordExpire = Date.now() + 10 * 60 * 1000; // 10 min
  return rawToken; // send the raw version to the user via email
};

module.exports = mongoose.model('User', UserSchema);
