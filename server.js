// server.js  — AuraLink Global Backend Entry Point
require('dotenv').config();

const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const connectDB = require('./config/db');
const errorHandler = require('./middleware/errorHandler');
const heartbeatService = require('./services/heartbeatService');

// ── Routes ────────────────────────────────────────────────────
const authRoutes = require('./routes/auth');
const unitRoutes = require('./routes/units');
const espRoutes = require('./routes/esp');

// ── Connect to MongoDB ────────────────────────────────────────
connectDB();

const app = express();

// ── CORS ──────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:5173',
  process.env.CLIENT_ORIGIN,
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // allow requests with no origin (mobile apps, curl, Postman)
    if (!origin) return callback(null, true);
    // allow any vercel.app subdomain
    if (origin.endsWith('.vercel.app')) return callback(null, true);
    // allow explicitly listed origins
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
}));

// ── Security middleware ───────────────────────────────────────
app.use(helmet());

// ── Body parsers ──────────────────────────────────────────────
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false }));

// ── Logging ───────────────────────────────────────────────────
if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
}

// ── Rate limiting ─────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, message: 'Too many requests, please try again later.' },
});

const espLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  message: { success: false, message: 'ESP rate limit exceeded.' },
});

// ── API Routes ────────────────────────────────────────────────
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/units', unitRoutes);
app.use('/api/esp', espLimiter, espRoutes);

// ── Health check ──────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.status(200).json({
    success: true,
    service: 'AuraLink Global API',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// ── 404 handler ───────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, message: `Route not found: ${req.method} ${req.originalUrl}` });
});

// ── Central error handler (must be last) ─────────────────────
app.use(errorHandler);

// ── HTTP Server ───────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
const server = http.createServer(app);

// ── WebSocket Server ──────────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  console.log(`[WS] Client connected. Total: ${wss.clients.size}`);

  const pingInterval = setInterval(() => {
    if (ws.readyState === ws.OPEN) ws.ping();
  }, 25_000);

  ws.on('close', () => {
    clearInterval(pingInterval);
    console.log(`[WS] Client disconnected. Total: ${wss.clients.size}`);
  });

  ws.on('error', err => console.error('[WS] Error:', err.message));

  ws.send(JSON.stringify({ type: 'CONNECTED', message: 'AuraLink Global WebSocket ready' }));
});

// ── Start HeartbeatService ────────────────────────────────────
heartbeatService.init(wss);

// ── Listen ────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🚀 AuraLink Global API running in ${process.env.NODE_ENV || 'development'} mode`);
  console.log(`   HTTP  → http://localhost:${PORT}`);
  console.log(`   WS    → ws://localhost:${PORT}/ws`);
  console.log(`   Health → http://localhost:${PORT}/health\n`);
  console.log(`   Allowed origins: ${ALLOWED_ORIGINS.join(', ')}\n`);
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
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
  shutdown('unhandledRejection');
});