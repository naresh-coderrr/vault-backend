'use strict';

/**
 * routes/chaos.js
 *
 * Chaos-engineering API – deliberately break things to test resilience:
 *
 *   POST  /api/v1/chaos/kill-node          – force a node OFFLINE
 *   POST  /api/v1/chaos/restore-node       – bring a node back (if reachable)
 *   POST  /api/v1/chaos/inject-corruption  – mark a replica as corrupted
 *   POST  /api/v1/chaos/inject-latency     – record a latency override for a node
 *   GET   /api/v1/chaos/status             – current chaos state snapshot
 */

const express = require('express');
const fetch   = require('node-fetch');
const router  = express.Router();

const db = require('../db/init');
const q  = require('../db/queries');

function getIo() {
  return require('../server').io;
}

// ---------------------------------------------------------------------------
// In-memory chaos state
// (Survives as long as the process lives; not persisted across restarts.)
// ---------------------------------------------------------------------------
const chaosState = {
  /** nodeId -> { killedAt: Date } */
  killedNodes: new Map(),

  /** chunkId+nodeId -> { injectedAt: Date, replicaId } */
  corruptedChunks: new Map(),

  /** nodeId -> latencyMs */
  latencyInjections: new Map(),
};

// ===========================================================================
// POST /api/v1/chaos/kill-node
// Body: { nodeId }
// ===========================================================================
router.post('/kill-node', async (req, res) => {
  const { nodeId } = req.body;
  if (!nodeId) return res.status(400).json({ error: 'nodeId is required' });

  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId);
  if (!node) return res.status(404).json({ error: 'Node not found' });

  try {
    // Mark node offline in DB
    q.updateNodeStatus(nodeId, 'OFFLINE', (node.missed_heartbeats || 0) + 1);

    // Record in chaos state
    chaosState.killedNodes.set(nodeId, {
      nodeId,
      nodeName:  node.node_name,
      killedAt:  new Date().toISOString(),
      endpoint:  node.endpoint_url,
    });

    const io = getIo();
    io.emit('node_killed', { nodeId, nodeName: node.node_name });

    // Trigger the healer to start fixing under-replicated chunks
    const { triggerHeal } = require('./healer-trigger');
    if (typeof triggerHeal === 'function') {
      triggerHeal(io).catch(() => {}); // fire-and-forget
    }

    const updatedNode = db.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId);
    return res.json({ message: `Node ${node.node_name} killed`, node: updatedNode });
  } catch (err) {
    console.error('[chaos/kill-node] Error:', err);
    return res.status(500).json({ error: 'Failed to kill node', detail: err.message });
  }
});

// ===========================================================================
// POST /api/v1/chaos/restore-node
// Body: { nodeId }
// ===========================================================================
router.post('/restore-node', async (req, res) => {
  const { nodeId } = req.body;
  if (!nodeId) return res.status(400).json({ error: 'nodeId is required' });

  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId);
  if (!node) return res.status(404).json({ error: 'Node not found' });

  // Verify the node is actually reachable before restoring
  try {
    const pingRes = await fetch(`${node.endpoint_url}/health`, { timeout: 4000 });
    if (!pingRes.ok) {
      return res.status(502).json({
        error: `Node responded with HTTP ${pingRes.status}; cannot restore`,
      });
    }
  } catch (err) {
    return res.status(502).json({
      error: `Node at ${node.endpoint_url} is not reachable: ${err.message}`,
    });
  }

  try {
    q.updateNodeStatus(nodeId, 'HEALTHY', 0);
    chaosState.killedNodes.delete(nodeId);

    const io = getIo();
    io.emit('node_restored', { nodeId, nodeName: node.node_name });

    const updatedNode = db.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId);
    return res.json({ message: `Node ${node.node_name} restored`, node: updatedNode });
  } catch (err) {
    console.error('[chaos/restore-node] Error:', err);
    return res.status(500).json({ error: 'Failed to restore node', detail: err.message });
  }
});

// ===========================================================================
// POST /api/v1/chaos/inject-corruption
// Body: { nodeId, chunkId }
// ===========================================================================
router.post('/inject-corruption', (req, res) => {
  const { nodeId, chunkId } = req.body;
  if (!nodeId || !chunkId) {
    return res.status(400).json({ error: 'nodeId and chunkId are required' });
  }

  // Look up the specific replica
  const replica = db
    .prepare(
      `SELECT cr.*, n.node_name, n.endpoint_url
       FROM chunk_replicas cr
       JOIN nodes n ON n.id = cr.node_id
       WHERE cr.chunk_id = ? AND cr.node_id = ?`
    )
    .get(chunkId, nodeId);

  if (!replica) {
    return res.status(404).json({
      error: `No replica found for chunk ${chunkId} on node ${nodeId}`,
    });
  }

  try {
    q.markReplicaCorrupted(replica.id);

    const key = `${chunkId}::${nodeId}`;
    chaosState.corruptedChunks.set(key, {
      chunkId,
      nodeId,
      nodeName:   replica.node_name,
      replicaId:  replica.id,
      injectedAt: new Date().toISOString(),
    });

    const io = getIo();
    io.emit('corruption_injected', {
      nodeId,
      chunkId,
      nodeName:  replica.node_name,
      replicaId: replica.id,
    });

    const updatedReplica = db
      .prepare('SELECT * FROM chunk_replicas WHERE id = ?')
      .get(replica.id);

    return res.json({ message: 'Corruption injected', replica: updatedReplica });
  } catch (err) {
    console.error('[chaos/inject-corruption] Error:', err);
    return res.status(500).json({ error: 'Failed to inject corruption', detail: err.message });
  }
});

// ===========================================================================
// POST /api/v1/chaos/inject-latency
// Body: { nodeId, latencyMs }
// ===========================================================================
router.post('/inject-latency', (req, res) => {
  const { nodeId, latencyMs } = req.body;
  if (!nodeId || latencyMs === undefined) {
    return res.status(400).json({ error: 'nodeId and latencyMs are required' });
  }

  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId);
  if (!node) return res.status(404).json({ error: 'Node not found' });

  const ms = Math.max(0, parseInt(latencyMs, 10) || 0);

  if (ms === 0) {
    chaosState.latencyInjections.delete(nodeId);
  } else {
    chaosState.latencyInjections.set(nodeId, {
      nodeId,
      nodeName:   node.node_name,
      latencyMs:  ms,
      injectedAt: new Date().toISOString(),
    });
  }

  const io = getIo();
  io.emit('latency_injected', { nodeId, nodeName: node.node_name, latencyMs: ms });

  return res.json({
    message:   ms === 0 ? 'Latency cleared' : `Latency of ${ms}ms injected`,
    nodeId,
    nodeName:  node.node_name,
    latencyMs: ms,
  });
});

// ===========================================================================
// GET /api/v1/chaos/status  –  snapshot of current chaos state
// ===========================================================================
router.get('/status', (_req, res) => {
  return res.json({
    killedNodes:        Array.from(chaosState.killedNodes.values()),
    corruptedChunks:    Array.from(chaosState.corruptedChunks.values()),
    latencyInjections:  Array.from(chaosState.latencyInjections.values()),
    summary: {
      killedNodeCount:      chaosState.killedNodes.size,
      corruptedChunkCount:  chaosState.corruptedChunks.size,
      latencyInjectedCount: chaosState.latencyInjections.size,
    },
  });
});

// Export the chaos state so other modules (e.g. heartbeat) can consult it
module.exports = router;
module.exports.chaosState = chaosState;
