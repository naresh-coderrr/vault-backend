/**
 * VAULT - Storage Node Server
 * ===========================
 * Each instance of this file IS a storage node.
 * Launch with: node storage-node.js --port=9001 --dir=./node_data/node1 --name=Node-Alpha
 */

const express = require('express');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Parse CLI arguments: --port=9001 --dir=./node_data/node1 --name=Node-Alpha
// ---------------------------------------------------------------------------
const args = {};
process.argv.slice(2).forEach(arg => {
  const [key, value] = arg.replace('--', '').split('=');
  args[key] = value;
});

const PORT      = parseInt(args.port) || 9001;
const DATA_DIR  = args.dir  || `./node_data/node_${PORT}`;
const NODE_NAME = args.name || `Node-${PORT}`;

// ---------------------------------------------------------------------------
// Bootstrap: ensure data directory exists
// ---------------------------------------------------------------------------
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Injected latency (chaos engineering)
// ---------------------------------------------------------------------------
let injectedLatency = 0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Calculate total bytes used inside DATA_DIR by summing all file sizes.
 * @returns {{ totalBytes: number, files: string[] }}
 */
function getDiskUsage() {
  try {
    const files = fs.readdirSync(DATA_DIR).filter(f => {
      try {
        return fs.statSync(path.join(DATA_DIR, f)).isFile();
      } catch {
        return false;
      }
    });
    const totalBytes = files.reduce((sum, f) => {
      try {
        return sum + fs.statSync(path.join(DATA_DIR, f)).size;
      } catch {
        return sum;
      }
    }, 0);
    return { totalBytes, files };
  } catch {
    return { totalBytes: 0, files: [] };
  }
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();

// JSON body parser for control endpoints (e.g. /chaos/latency)
app.use(express.json());

// ---------------------------------------------------------------------------
// Middleware: artificial latency injection
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  if (injectedLatency > 0) {
    setTimeout(next, injectedLatency);
  } else {
    next();
  }
});

// ---------------------------------------------------------------------------
// Request logger
// ---------------------------------------------------------------------------
app.use((req, _res, next) => {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${req.method} ${req.path}`);
  next();
});

// ---------------------------------------------------------------------------
// ENDPOINTS
// ---------------------------------------------------------------------------

/**
 * POST /chunks/:id
 * Store a raw binary chunk on this node.
 * Body must be application/octet-stream (up to 50 MB).
 */
app.post(
  '/chunks/:id',
  express.raw({ limit: '50mb', type: '*/*' }),
  (req, res) => {
    const chunkId  = req.params.id;
    const buffer   = req.body;

    if (!buffer || buffer.length === 0) {
      return res.status(400).json({ error: 'Empty body — expected raw binary chunk data' });
    }

    const filePath = path.join(DATA_DIR, chunkId);
    try {
      fs.writeFileSync(filePath, buffer);
      console.log(`  ✅ Stored chunk ${chunkId} (${buffer.length} bytes)`);
      return res.status(201).json({
        id:      chunkId,
        size:    buffer.length,
        stored:  true,
        node:    NODE_NAME,
        path:    filePath
      });
    } catch (err) {
      console.error(`  ❌ Failed to store chunk ${chunkId}:`, err.message);
      return res.status(500).json({ error: 'Failed to write chunk to disk', detail: err.message });
    }
  }
);

/**
 * GET /chunks/:id
 * Retrieve a stored chunk by ID.
 */
app.get('/chunks/:id', (req, res) => {
  const chunkId  = req.params.id;
  const filePath = path.join(DATA_DIR, chunkId);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: `Chunk ${chunkId} not found on node ${NODE_NAME}` });
  }

  try {
    const buffer = fs.readFileSync(filePath);
    res.set('Content-Type', 'application/octet-stream');
    res.set('X-Chunk-Id', chunkId);
    res.set('X-Node-Name', NODE_NAME);
    res.set('X-Chunk-Size', String(buffer.length));
    return res.send(buffer);
  } catch (err) {
    console.error(`  ❌ Failed to read chunk ${chunkId}:`, err.message);
    return res.status(500).json({ error: 'Failed to read chunk from disk', detail: err.message });
  }
});

/**
 * DELETE /chunks/:id
 * Delete a stored chunk from this node.
 */
app.delete('/chunks/:id', (req, res) => {
  const chunkId  = req.params.id;
  const filePath = path.join(DATA_DIR, chunkId);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: `Chunk ${chunkId} not found on node ${NODE_NAME}` });
  }

  try {
    fs.unlinkSync(filePath);
    console.log(`  🗑️  Deleted chunk ${chunkId}`);
    return res.status(204).send();
  } catch (err) {
    console.error(`  ❌ Failed to delete chunk ${chunkId}:`, err.message);
    return res.status(500).json({ error: 'Failed to delete chunk', detail: err.message });
  }
});

/**
 * GET /health
 * Returns node health metrics. Used by the heartbeat daemon.
 */
app.get('/health', (_req, res) => {
  const { totalBytes, files } = getDiskUsage();

  return res.status(200).json({
    nodeId:         PORT,
    name:           NODE_NAME,
    port:           PORT,
    status:         'HEALTHY',
    usedCapacity:   totalBytes,
    totalCapacity:  10737418240,   // 10 GiB
    freeCapacity:   10737418240 - totalBytes,
    chunksStored:   files.length,
    dataDir:        path.resolve(DATA_DIR),
    injectedLatency,
    timestamp:      new Date().toISOString()
  });
});

/**
 * POST /chaos/latency
 * Inject artificial latency into all responses (chaos engineering).
 * Body: { "latencyMs": 2000 }
 */
app.post('/chaos/latency', (req, res) => {
  const { latencyMs } = req.body;

  if (typeof latencyMs !== 'number' || latencyMs < 0) {
    return res.status(400).json({ error: 'latencyMs must be a non-negative number' });
  }

  injectedLatency = latencyMs;
  console.log(`⚡ Chaos: Injected latency set to ${latencyMs}ms`);
  return res.status(200).json({
    applied:    true,
    latencyMs,
    node:       NODE_NAME,
    timestamp:  new Date().toISOString()
  });
});

/**
 * GET /chunks
 * List all chunk IDs stored on this node.
 */
app.get('/chunks', (_req, res) => {
  const { files, totalBytes } = getDiskUsage();
  return res.status(200).json({
    node:       NODE_NAME,
    chunks:     files,
    count:      files.length,
    totalBytes,
    timestamp:  new Date().toISOString()
  });
});

// ---------------------------------------------------------------------------
// 404 catch-all
// ---------------------------------------------------------------------------
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found on storage node ${NODE_NAME}` });
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`\n💾 Storage Node [${NODE_NAME}] running on port ${PORT}`);
  console.log(`   Data directory: ${path.resolve(DATA_DIR)}`);
  console.log(`   Total capacity: 10 GiB`);
  console.log(`   Endpoints:`);
  console.log(`     POST   /chunks/:id   — store a chunk`);
  console.log(`     GET    /chunks/:id   — retrieve a chunk`);
  console.log(`     DELETE /chunks/:id   — delete a chunk`);
  console.log(`     GET    /chunks       — list all chunks`);
  console.log(`     GET    /health       — node health metrics`);
  console.log(`     POST   /chaos/latency — inject latency\n`);
});
