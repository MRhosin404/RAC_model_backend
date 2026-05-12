// routes/auth.js
const express        = require('express');
const router         = express.Router();
const User           = require('../models/User');
const { protect }    = require('../middleware/protect');

// ── Helper: send token response ───────────────────────────────
const sendTokenResponse = (user, statusCode, res) => {
  const token = user.getSignedJwt();

  res.status(statusCode).json({
    success: true,
    token,
    user: {
      id:    user._id,
      name:  user.name,
      email: user.email,
      role:  user.role,
    },
  });
};

// ── POST /api/auth/register ───────────────────────────────────
// @desc    Create a new user account
// @access  Public
router.post('/register', async (req, res, next) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ success: false, message: 'Please provide name, email, and password' });
    }

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(400).json({ success: false, message: 'Email already registered' });
    }

    const user = await User.create({ name, email, password });
    sendTokenResponse(user, 201, res);
  } catch (err) {
    next(err);
  }
});

// ── POST /api/auth/login ──────────────────────────────────────
// @desc    Authenticate user and return JWT
// @access  Public
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Please provide email and password' });
    }

    // password is select:false — must explicitly include it
    const user = await User.findOne({ email: email.toLowerCase() }).select('+password');
    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const isMatch = await user.matchPassword(password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    user.lastLogin = new Date();
    await user.save({ validateBeforeSave: false });

    sendTokenResponse(user, 200, res);
  } catch (err) {
    next(err);
  }
});

// ── GET /api/auth/me ──────────────────────────────────────────
// @desc    Get current logged-in user profile
// @access  Private
router.get('/me', protect, async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id).populate('acUnits', 'name location isOnline');
    res.status(200).json({ success: true, data: user });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/auth/logout ─────────────────────────────────────
// @desc    Clear cookie (if used) — client should delete the token
// @access  Private
router.post('/logout', protect, (req, res) => {
  res.clearCookie('token');
  res.status(200).json({ success: true, message: 'Logged out successfully' });
});

module.exports = router;
