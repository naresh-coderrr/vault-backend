/**
 * VAULT - Self-Healing Daemon
 * ============================
 * Detects under-replicated chunks (chunks whose healthy replica count is
 * below the file's replication_factor) and automatically repairs them by
 * copying data from a healthy source node to a healthy target node.
 *
 * Healing pipeline per chunk:
 *   1. Find a healthy, non-corrupted source replica.
 *   2. Find a healthy target node that does NOT already hold the chunk.
 *   3. Stream the chunk from source → target via HTTP.
 *   4. Record the new replica in chunk_replicas.
 *   5. Update the target node's used_capacity counter.
 *   6. Emit a "chunk_healed" Socket.IO event.
 */

'use strict';

require('dotenv').config();

const fetch  = require('node-fetch');
const { v4: uuidv4 } = require('uuid');
const db     = require('../db/init');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** How often (ms) the healer daemon runs a full scan. */
const INTERVAL = parseInt(process.env.HEAL_INTERVAL, 10) || 10000;

// ---------------------------------------------------------------------------
// Core healing logic
// ---------------------------------------------------------------------------

/**
 * Attempt to heal a single under-replicated chunk by replicating it from
 * a healthy source node to a healthy target node.
 *
 * @param {{
 *   id:                string,
 *   file_id:           string,
 *   checksum:          string,
 *   filename:          string,
 *   replication_factor: number,
 *   healthy_count:     number
 * }} chunk  - The under-replicated chunk row from the DB.
 *
 * @param {{
 *   id:       string,
 *   filename: string,
 *   replication_factor: number
 * }} file  - Parent file metadata.
 *
 * @param {import('socket.io').Server|null} io - Optional Socket.IO server.
 * @returns {Promise<boolean>} true if healing succeeded, false otherwise.
 */
async function healChunk(chunk, file, io) {
  // ------------------------------------------------------------------
  // Step 1: Find a healthy, non-corrupted source replica
  // ------------------------------------------------------------------
  let sourceReplica;
  try {
    sourceReplica = db.prepare(`
      SELECT cr.id        AS replica_id,
             cr.chunk_id,
             cr.node_id,
             n.endpoint_url,
             n.node_name
      FROM   chunk_replicas cr
      JOIN   nodes n ON n.id = cr.node_id
      WHERE  cr.chunk_id    = ?
        AND  cr.is_corrupted = 0
        AND  n.status        = 'HEALTHY'
      LIMIT  1
    `).get(chunk.id);
  } catch (err) {
    console.error(`[healer] DB error finding source replica for chunk ${chunk.id}:`, err.message);
    return false;
  }

  if (!sourceReplica) {
    console.warn(`[healer] No healthy source replica available for chunk ${chunk.id.slice(0, 8)}...`);
    return false;
  }

  // ------------------------------------------------------------------
  // Step 2: Find a healthy target node NOT already holding this chunk
  // ------------------------------------------------------------------
  let existingNodeIds;
  try {
    existingNodeIds = db
      .prepare('SELECT node_id FROM chunk_replicas WHERE chunk_id = ?')
      .all(chunk.id)
      .map(r => r.node_id);
  } catch (err) {
    console.error(`[healer] DB error listing existing replicas for chunk ${chunk.id}:`, err.message);
    return false;
  }

  // Build a parameterised NOT IN clause
  let targetNode;
  try {
    if (existingNodeIds.length === 0) {
      targetNode = db.prepare(`
        SELECT * FROM nodes
        WHERE  status = 'HEALTHY'
        ORDER  BY used_capacity ASC
        LIMIT  1
      `).get();
    } else {
      const placeholders = existingNodeIds.map(() => '?').join(', ');
      targetNode = db.prepare(`
        SELECT * FROM nodes
        WHERE  status = 'HEALTHY'
          AND  id NOT IN (${placeholders})
        ORDER  BY used_capacity ASC
        LIMIT  1
      `).get(...existingNodeIds);
    }
  } catch (err) {
    console.error(`[healer] DB error finding target node for chunk ${chunk.id}:`, err.message);
    return false;
  }

  if (!targetNode) {
    console.warn(`[healer] No available healthy target node to replicate chunk ${chunk.id.slice(0, 8)}...`);
    return false;
  }

  // ------------------------------------------------------------------
  // Step 3: Stream chunk from source → target
  // ------------------------------------------------------------------
  let chunkBuffer;
  try {
    const fetchRes = await fetch(`${sourceReplica.endpoint_url}/chunks/${chunk.id}`);
    if (!fetchRes.ok) {
      console.warn(
        `[healer] Failed to fetch chunk ${chunk.id.slice(0, 8)}... from ${sourceReplica.endpoint_url} ` +
        `(HTTP ${fetchRes.status})`
      );
      return false;
    }
    chunkBuffer = await fetchRes.buffer();
  } catch (err) {
    console.error(`[healer] Network error fetching chunk ${chunk.id.slice(0, 8)}...:`, err.message);
    return false;
  }

  try {
    const postRes = await fetch(`${targetNode.endpoint_url}/chunks/${chunk.id}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body:    chunkBuffer
    });
    if (!postRes.ok) {
      console.warn(
        `[healer] Failed to POST chunk ${chunk.id.slice(0, 8)}... to ${targetNode.endpoint_url} ` +
        `(HTTP ${postRes.status})`
      );
      return false;
    }
  } catch (err) {
    console.error(`[healer] Network error POSTing chunk ${chunk.id.slice(0, 8)}...:`, err.message);
    return false;
  }

  // ------------------------------------------------------------------
  // Step 4: Record new replica in DB
  // ------------------------------------------------------------------
  try {
    db.prepare(`
      INSERT OR IGNORE INTO chunk_replicas (id, chunk_id, node_id, is_corrupted, created_at)
      VALUES (?, ?, ?, 0, datetime('now'))
    `).run(uuidv4(), chunk.id, targetNode.id);
  } catch (err) {
    console.error(`[healer] DB error inserting new replica for chunk ${chunk.id}:`, err.message);
    // Don't return false here — the data IS on the target node even if DB insert failed
  }

  // ------------------------------------------------------------------
  // Step 5: Update target node's used_capacity counter
  // ------------------------------------------------------------------
  try {
    db.prepare(`
      UPDATE nodes
      SET used_capacity = used_capacity + ?
      WHERE id = ?
    `).run(chunkBuffer.length, targetNode.id);
  } catch (err) {
    console.error(`[healer] DB error updating capacity for node ${targetNode.id}:`, err.message);
  }

  // ------------------------------------------------------------------
  // Step 6: Emit Socket.IO event
  // ------------------------------------------------------------------
  if (io) {
    io.emit('chunk_healed', {
      chunkId:   chunk.id,
      fileId:    file.id,
      filename:  file.filename,
      fromNode:  sourceReplica.endpoint_url,
      toNode:    targetNode.endpoint_url,
      bytes:     chunkBuffer.length,
      timestamp: new Date().toISOString()
    });
  }

  return true;
}

// ---------------------------------------------------------------------------
// Scan + heal cycle
// ---------------------------------------------------------------------------

/**
 * Scan all chunks and heal any that are under-replicated.
 *
 * @param {import('socket.io').Server|null} io
 */
async function runHealer(io) {
  let underReplicated;
  try {
    underReplicated = db.prepare(`
      SELECT  c.id,
              c.file_id,
              c.checksum,
              f.filename,
              f.replication_factor,
              COUNT(
                CASE WHEN n.status = 'HEALTHY' AND cr.is_corrupted = 0 THEN 1 END
              ) AS healthy_count
      FROM    chunks c
      JOIN    files f               ON f.id    = c.file_id
      LEFT JOIN chunk_replicas cr   ON cr.chunk_id = c.id
      LEFT JOIN nodes n             ON n.id    = cr.node_id
      GROUP BY c.id
      HAVING  healthy_count < f.replication_factor
    `).all();
  } catch (err) {
    console.error('[healer] DB error querying under-replicated chunks:', err.message);
    return;
  }

  if (underReplicated.length === 0) return;

  console.log(`🔧 Healer: Found ${underReplicated.length} under-replicated chunk(s)`);

  if (io) {
    io.emit('heal_started', {
      count:     underReplicated.length,
      timestamp: new Date().toISOString()
    });
  }

  let healed = 0;
  let failed = 0;

  for (const row of underReplicated) {
    let file;
    try {
      file = db.prepare('SELECT * FROM files WHERE id = ?').get(row.file_id);
    } catch (err) {
      console.error(`[healer] DB error fetching file ${row.file_id}:`, err.message);
      failed++;
      continue;
    }

    const ok = await healChunk(row, file || { id: row.file_id, filename: row.filename }, io);
    if (ok) {
      console.log(
        `  ✅ Healed chunk ${row.id.slice(0, 8)}... for "${row.filename}"` +
        ` (was: ${row.healthy_count}/${row.replication_factor} replicas)`
      );
      healed++;
    } else {
      console.log(`  ⚠️  Could not heal chunk ${row.id.slice(0, 8)}... for "${row.filename}"`);
      failed++;
    }
  }

  console.log(`🔧 Healer cycle complete: ${healed} healed, ${failed} failed`);

  if (io) {
    io.emit('heal_complete', {
      total:     underReplicated.length,
      healed,
      failed,
      timestamp: new Date().toISOString()
    });
  }
}

// ---------------------------------------------------------------------------
// Daemon entry point
// ---------------------------------------------------------------------------

/**
 * Start the self-healing daemon. Runs every INTERVAL milliseconds.
 *
 * @param {import('socket.io').Server|null} io
 */
function startHealerDaemon(io) {
  console.log(`🔧 Self-healing daemon started (interval: ${INTERVAL}ms)`);

  setInterval(() => {
    runHealer(io).catch(err =>
      console.error('[healer] Unhandled error in heal cycle:', err.message)
    );
  }, INTERVAL);
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------
module.exports = {
  startHealerDaemon,
  runHealer,
  healChunk,
  INTERVAL
};
