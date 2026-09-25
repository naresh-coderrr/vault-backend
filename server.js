'use strict';

require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');

// ---------------------------------------------------------------------------
// Route imports
// ---------------------------------------------------------------------------
const objectsRouter = require('./routes/objects');
const clusterRouter = require('./routes/cluster');
const chaosRouter   = require('./routes/chaos');

// ---------------------------------------------------------------------------
// Service daemon imports
// ---------------------------------------------------------------------------
const { startHeartbeatDaemon } = require('./services/heartbeat');
const { startHealerDaemon }    = require('./services/healer');
const { startScrubberDaemon }  = require('./services/scrubber');

// ---------------------------------------------------------------------------
// App + HTTP server + Socket.IO
// ---------------------------------------------------------------------------
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' }
});

// Export io so services / routes can emit events
module.exports.io = io;

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());

// Serve the companion frontend (vault-website) from the sibling directory
app.use(express.static(path.join(__dirname, '../vault-website')));

// ---------------------------------------------------------------------------
// API Routes
// ---------------------------------------------------------------------------
app.use('/api/v1/objects', objectsRouter);
app.use('/api/v1/cluster', clusterRouter);
app.use('/api/v1/chaos',   chaosRouter);

// Simple health-check probe
app.get('/api/health', (_req, res) =>
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
);

// Catch-all: serve the SPA index for any unmatched GET route
app.get('*', (_req, res) => {
  const indexPath = path.join(__dirname, '../vault-website/index.html');
  res.sendFile(indexPath, (err) => {
    if (err) res.status(404).json({ error: 'Not found' });
  });
});

// ---------------------------------------------------------------------------
// WebSocket connection handling
// ---------------------------------------------------------------------------
io.on('connection', (socket) => {
  console.log(`📡  Client connected    : ${socket.id}`);
  socket.on('disconnect', () =>
    console.log(`📴  Client disconnected : ${socket.id}`)
  );
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🔐  Vault Gateway running at http://localhost:${PORT}`);
  console.log(`📡  WebSocket server ready`);
  console.log(`🗄️   Database: ${process.env.DB_PATH || './vault.db'}\n`);

  // Background daemons
  startHeartbeatDaemon(io);
  startHealerDaemon(io);
  startScrubberDaemon(io);
});
