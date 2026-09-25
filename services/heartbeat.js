/**
 * VAULT - Heartbeat Daemon
 * ========================
 * Periodically pings all registered storage nodes to track their health.
 * Updates node status in the SQLite database and emits Socket.IO events
 * when a node's status changes.
 *
 * Status transitions:
 *   HEALTHY  → DEGRADED  (1-2 missed heartbeats)
 *   DEGRADED → OFFLINE   (>= MAX_MISSED missed heartbeats)
 *   OFFLINE  → HEALTHY   (ping succeeds again)
 */

'use strict';

require('dotenv').config();

const fetch = require('node-fetch');
const db    = require('../db/init');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** How often (ms) the daemon pings every node. */
const INTERVAL = parseInt(process.env.HEARTBEAT_INTERVAL, 10) || 5000;

/** Number of consecutive missed pings before a node is marked OFFLINE. */
const MAX_MISSED = 3;

/** Per-ping timeout in ms before we abort the fetch. */
const PING_TIMEOUT_MS = 3000;

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/**
 * Ping a single node's /health endpoint.
 * On success, update the node's last-seen timestamp and used capacity.
 *
 * @param {{ id: number, endpoint_url: string, node_name: string }} node
 * @returns {Promise<boolean>} true if the node responded with HTTP 200, false otherwise.
 */
async function pingNode(node) {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);

  try {
    const res = await fetch(`${node.endpoint_url}/health`, {
      signal: controller.signal
    });
    clearTimeout(timer);

    if (res.ok) {
      let data = {};
      try {
        data = await res.json();
      } catch {
        // non-JSON health response — still counts as alive
      }

      // Update heartbeat timestamp and used capacity in DB
      updateNodeHeartbeat(node.id, data.usedCapacity || 0);
      return true;
    }

    clearTimeout(timer);
    return false;
  } catch (err) {
    clearTimeout(timer);
    // AbortError = timeout; ECONNREFUSED = node down — both return false
    return false;
  }
}

/**
 * Update a node's heartbeat timestamp and used capacity.
 *
 * @param {number|string} nodeId
 * @param {number}        usedCapacity  - Bytes used on the remote node's disk.
 */
function updateNodeHeartbeat(nodeId, usedCapacity) {
  try {
    db.prepare(`
      UPDATE nodes
      SET last_heartbeat = datetime('now'),
          used_capacity  = ?
      WHERE id = ?
    `).run(usedCapacity, nodeId);
  } catch (err) {
    console.error(`[heartbeat] DB error updating heartbeat for node ${nodeId}:`, err.message);
  }
}

/**
 * Run one full heartbeat cycle across ALL registered nodes.
 * Determines new status, persists changes, and emits Socket.IO events.
 *
 * @param {import('socket.io').Server|null} io  - Optional Socket.IO server for live updates.
 */
async function runHeartbeat(io) {
  let nodes;
  try {
    nodes = db.prepare('SELECT * FROM nodes').all();
  } catch (err) {
    console.error('[heartbeat] Failed to query nodes from DB:', err.message);
    return;
  }

  for (const node of nodes) {
    const alive  = await pingNode(node);
    const missed = alive ? 0 : (node.missed_heartbeats || 0) + 1;

    // Determine new status
    let newStatus = node.status;
    if (alive) {
      newStatus = 'HEALTHY';
    } else if (missed >= MAX_MISSED) {
      newStatus = 'OFFLINE';
    } else if (missed >= 1) {
      newStatus = 'DEGRADED';
    }

    const statusChanged = newStatus !== node.status;

    // Persist status + missed count only when something changed, or we want
    // to keep the missed counter accurate.
    if (statusChanged || !alive) {
      try {
        db.prepare(`
          UPDATE nodes
          SET status            = ?,
              missed_heartbeats = ?
          WHERE id = ?
        `).run(newStatus, missed, node.id);
      } catch (err) {
        console.error(`[heartbeat] DB error updating status for node ${node.id}:`, err.message);
      }

      if (statusChanged) {
        const emoji = newStatus === 'HEALTHY' ? '💚' : newStatus === 'DEGRADED' ? '🟡' : '🔴';
        console.log(
          `${emoji} [heartbeat] Node "${node.node_name}" ${node.status} → ${newStatus}` +
          (alive ? '' : ` (missed: ${missed}/${MAX_MISSED})`)
        );

        // Emit real-time event to connected dashboard clients
        if (io) {
          io.emit('node_status_changed', {
            nodeId:    node.id,
            nodeName:  node.node_name,
            oldStatus: node.status,
            newStatus,
            missed,
            timestamp: new Date().toISOString()
          });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Daemon entry point
// ---------------------------------------------------------------------------

/**
 * Start the heartbeat daemon. Runs immediately once, then every INTERVAL ms.
 *
 * @param {import('socket.io').Server|null} io  - Optional Socket.IO server.
 */
function startHeartbeatDaemon(io) {
  console.log(`💓 Heartbeat daemon started (interval: ${INTERVAL}ms, timeout: ${PING_TIMEOUT_MS}ms)`);

  // Run immediately on startup
  runHeartbeat(io).catch(err =>
    console.error('[heartbeat] Error in initial heartbeat run:', err.message)
  );

  // Schedule recurring pings
  setInterval(() => {
    runHeartbeat(io).catch(err =>
      console.error('[heartbeat] Error in heartbeat run:', err.message)
    );
  }, INTERVAL);
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------
module.exports = {
  startHeartbeatDaemon,
  runHeartbeat,
  pingNode,
  updateNodeHeartbeat,
  INTERVAL,
  MAX_MISSED
};
