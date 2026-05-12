// server.js  — AuraLink Global Backend Entry Point
require('dotenv').config();

const http             = require('http');
const express          = require('express');
const { WebSocketServer } = require('ws');
const cors             = require('cors');
const helmet           = require('helmet');
const morgan           = require('morgan');
const rateLimit        = require('express-rate-limit');
const connectDB        = require('./config/db');
const errorHandler     = require('./middleware/errorHandler');
const heartbeatService = require('./services/heartbeatService');

// ── Routes ────────────────────────────────────────────────────
const authRoutes  = require('./routes/auth');
const unitRoutes  = require('./routes/units');
const espRoutes   = require('./routes/esp');

// ── Connect to MongoDB ────────────────────────────────────────
connectDB();

const app = express();

// ── Security middleware ───────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin:      process.env.CLIENT_ORIGIN || 'http://localhost:3000',
  credentials: true,
}));

// ── Body parsers ──────────────────────────────────────────────
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false }));

// ── Logging ───────────────────────────────────────────────────
if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
}

// ── Rate limiting ─────────────────────────────────────────────
// Stricter limit on auth routes to prevent brute-force
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max:      20,
  message:  { success: false, message: 'Too many requests, please try again later.' },
});

// Looser limit for ESP polling (5 s interval × many devices)
const espLimiter = rateLimit({
  windowMs: 60 * 1000,   // 1 minute
  max:      300,
  message:  { success: false, message: 'ESP rate limit exceeded.' },
});

// ── API Routes ────────────────────────────────────────────────
app.use('/api/auth',  authLimiter, authRoutes);
app.use('/api/units', unitRoutes);
app.use('/api/esp',   espLimiter,  espRoutes);

// ── Health check ──────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.status(200).json({
    success:   true,
    service:   'AuraLink Global API',
    timestamp: new Date().toISOString(),
    uptime:    process.uptime(),
  });
});

// ── 404 handler ───────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, message: `Route not found: ${req.method} ${req.originalUrl}` });
});

// ── Central error handler (must be last) ─────────────────────
app.use(errorHandler);

// ── HTTP Server ───────────────────────────────────────────────
const PORT   = process.env.PORT || 5000;
const server = http.createServer(app);

// ── WebSocket Server (shares the same HTTP port) ──────────────
//
// React dashboard connects to ws://localhost:5000
// The server pushes real-time events (DEVICE_STATUS_CHANGED, STATE_UPDATED,
// SENSOR_UPDATE, DEVICE_ONLINE, COMMANDS_EXECUTED) to all connected clients.
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  console.log(`[WS] Client connected. Total: ${wss.clients.size}`);

  // Keep-alive ping to prevent proxy timeouts
  const pingInterval = setInterval(() => {
    if (ws.readyState === ws.OPEN) ws.ping();
  }, 25_000);

  ws.on('close', () => {
    clearInterval(pingInterval);
    console.log(`[WS] Client disconnected. Total: ${wss.clients.size}`);
  });

  ws.on('error', err => console.error('[WS] Error:', err.message));

  // Send a welcome handshake
  ws.send(JSON.stringify({ type: 'CONNECTED', message: 'AuraLink Global WebSocket ready' }));
});

// ── Start HeartbeatService (needs wss to broadcast) ──────────
heartbeatService.init(wss);

// ── Listen ────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🚀 AuraLink Global API running in ${process.env.NODE_ENV || 'development'} mode`);
  console.log(`   HTTP  → http://localhost:${PORT}`);
  console.log(`   WS    → ws://localhost:${PORT}/ws`);
  console.log(`   Health → http://localhost:${PORT}/health\n`);
});

// ── Graceful shutdown ─────────────────────────────────────────
const shutdown = (signal) => {
  console.log(`\n[${signal}] Shutting down gracefully…`);
  server.close(() => {
    console.log('HTTP server closed.');
    process.exit(0);
  });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
  shutdown('unhandledRejection');
});
