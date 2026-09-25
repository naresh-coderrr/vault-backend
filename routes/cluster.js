'use strict';

/**
 * routes/cluster.js
 *
 * Cluster management endpoints:
 *   GET    /api/v1/cluster/nodes        – list all nodes with capacity + replica stats
 *   POST   /api/v1/cluster/nodes        – register a new storage node
 *   GET    /api/v1/cluster/nodes/:id    – single node detail with chunk list
 *   GET    /api/v1/cluster/health       – cluster-wide health summary
 *   DELETE /api/v1/cluster/nodes/:id    – decommission / mark OFFLINE
 */

const express = require('express');
const fetch   = require('node-fetch');
const { v4: uuidv4 } = require('uuid');

const router = express.Router();
const db     = require('../db/init');
const q      = require('../db/queries');

function getIo() {
  return require('../server').io;
}

// ---------------------------------------------------------------------------
// Utility: compute human-readable time since an ISO timestamp
// ---------------------------------------------------------------------------
function msSince(isoString) {
  if (!isoString) return null;
  const ts = new Date(isoString + (isoString.endsWith('Z') ? '' : 'Z')).getTime();
  return Date.now() - ts;
}

// ===========================================================================
// GET /api/v1/cluster/nodes
// ===========================================================================
router.get('/nodes', (_req, res) => {
  try {
    const nodes = q.getAllNodes();

    const enriched = nodes.map((node) => {
      // Per-node replica counts
      const replicaRow = db
        .prepare(
          `SELECT
             COUNT(*)                                              AS total_replicas,
             SUM(CASE WHEN cr.is_corrupted = 0 THEN 1 ELSE 0 END) AS healthy_replicas
           FROM chunk_replicas cr
           WHERE cr.node_id = ?`
        )
        .get(node.id);

      const usedPercent =
        node.total_capacity > 0
          ? ((node.used_capacity / node.total_capacity) * 100).toFixed(2)
          : '0.00';

      return {
        ...node,
        stored_replicas_count: replicaRow?.total_replicas   ?? 0,
        healthy_replica_count: replicaRow?.healthy_replicas ?? 0,
        capacity: {
          total:       node.total_capacity,
          used:        node.used_capacity,
          usedPercent: parseFloat(usedPercent),
        },
        time_since_heartbeat_ms: msSince(node.last_heartbeat),
      };
    });

    return res.json(enriched);
  } catch (err) {
    console.error('[cluster/nodes] GET error:', err);
    return res.status(500).json({ error: 'Failed to retrieve nodes', detail: err.message });
  }
});

// ===========================================================================
// POST /api/v1/cluster/nodes  –  register a new node
// ===========================================================================
router.post('/nodes', async (req, res) => {
  const { nodeUrl, nodeName, totalCapacity } = req.body;

  if (!nodeUrl || !nodeName) {
    return res.status(400).json({ error: 'nodeUrl and nodeName are required' });
  }

  // Normalise URL (remove trailing slash)
  const endpoint = nodeUrl.replace(/\/$/, '');

  // Verify the node is reachable
  try {
    const pingRes = await fetch(`${endpoint}/health`, { timeout: 5000 });
    if (!pingRes.ok) {
      return res.status(502).json({
        error: `Node at ${endpoint} responded with HTTP ${pingRes.status}`,
      });
    }
  } catch (err) {
    return res.status(502).json({
      error: `Cannot reach node at ${endpoint}: ${err.message}`,
    });
  }

  try {
    const nodeId = uuidv4();
    q.insertNode({
      id:             nodeId,
      node_name:      nodeName,
      endpoint_url:   endpoint,
      total_capacity: totalCapacity ?? 10 * 1024 * 1024 * 1024,
    });

    const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId);

    const io = getIo();
    io.emit('node_registered', { nodeId, nodeName, endpoint });

    return res.status(201).json(node);
  } catch (err) {
    // Unique constraint on endpoint_url
    if (err.message && err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: `A node with URL ${endpoint} is already registered` });
    }
    console.error('[cluster/nodes] POST error:', err);
    return res.status(500).json({ error: 'Failed to register node', detail: err.message });
  }
});

// ===========================================================================
// GET /api/v1/cluster/nodes/:id  –  single node with stored chunks
// ===========================================================================
router.get('/nodes/:id', (req, res) => {
  try {
    const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
    if (!node) return res.status(404).json({ error: 'Node not found' });

    // Chunks stored on this node (joined for context)
    const chunks = db
      .prepare(
        `SELECT c.id AS chunk_id, c.chunk_index, c.size, c.checksum,
                cr.id AS replica_id, cr.is_corrupted, cr.last_verified,
                f.id AS file_id, f.filename
         FROM   chunk_replicas cr
         JOIN   chunks c ON c.id = cr.chunk_id
         JOIN   files  f ON f.id = c.file_id
         WHERE  cr.node_id = ?
         ORDER BY f.filename ASC, c.chunk_index ASC`
      )
      .all(req.params.id);

    return res.json({
      ...node,
      time_since_heartbeat_ms: msSince(node.last_heartbeat),
      stored_chunks:           chunks,
    });
  } catch (err) {
    console.error('[cluster/nodes/:id] GET error:', err);
    return res.status(500).json({ error: 'Failed to retrieve node', detail: err.message });
  }
});

// ===========================================================================
// GET /api/v1/cluster/health  –  overall cluster health summary
// ===========================================================================
router.get('/health', (_req, res) => {
  try {
    const nodeStats = db
      .prepare(
        `SELECT
           COUNT(*)                                                            AS total_nodes,
           SUM(CASE WHEN status = 'HEALTHY'  THEN 1 ELSE 0 END)               AS healthy_nodes,
           SUM(CASE WHEN status = 'DEGRADED' THEN 1 ELSE 0 END)               AS degraded_nodes,
           SUM(CASE WHEN status = 'OFFLINE'  THEN 1 ELSE 0 END)               AS offline_nodes
         FROM nodes`
      )
      .get();

    const fileStats = db
      .prepare(
        `SELECT
           COUNT(*)                                                            AS total_files,
           (SELECT COUNT(*) FROM chunks)                                       AS total_chunks,
           (SELECT COUNT(*) FROM chunk_replicas)                               AS total_replicas
         FROM files`
      )
      .get();

    const underReplicated = q.getUnderReplicatedChunks().length;

    // Health score: 100% if everything is healthy; deduct proportionally for
    // offline / degraded nodes and under-replicated chunks.
    const totalNodes   = nodeStats.total_nodes   || 1;
    const healthyNodes = nodeStats.healthy_nodes || 0;

    const nodeScore  = (healthyNodes / totalNodes) * 100;
    const chunkPenalty =
      fileStats.total_chunks > 0
        ? (underReplicated / fileStats.total_chunks) * 20 // max 20-point penalty
        : 0;

    const healthScore = Math.max(0, Math.min(100, nodeScore - chunkPenalty));

    return res.json({
      totalNodes:           nodeStats.total_nodes,
      healthyNodes:         nodeStats.healthy_nodes,
      degradedNodes:        nodeStats.degraded_nodes,
      offlineNodes:         nodeStats.offline_nodes,
      healthScore:          parseFloat(healthScore.toFixed(1)),
      totalFiles:           fileStats.total_files,
      totalChunks:          fileStats.total_chunks,
      totalReplicas:        fileStats.total_replicas,
      underReplicatedChunks: underReplicated,
    });
  } catch (err) {
    console.error('[cluster/health] GET error:', err);
    return res.status(500).json({ error: 'Failed to compute health', detail: err.message });
  }
});

// ===========================================================================
// DELETE /api/v1/cluster/nodes/:id  –  decommission a node
// ===========================================================================
router.delete('/nodes/:id', (req, res) => {
  try {
    const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
    if (!node) return res.status(404).json({ error: 'Node not found' });

    q.updateNodeStatus(req.params.id, 'OFFLINE', node.missed_heartbeats || 0);

    const io = getIo();
    io.emit('node_decommissioned', { nodeId: req.params.id, nodeName: node.node_name });

    return res.json({ message: `Node ${node.node_name} marked OFFLINE`, node });
  } catch (err) {
    console.error('[cluster/nodes/:id] DELETE error:', err);
    return res.status(500).json({ error: 'Failed to decommission node', detail: err.message });
  }
});

module.exports = router;
