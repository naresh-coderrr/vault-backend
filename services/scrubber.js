/**
 * VAULT - Data Integrity Scrubber
 * =================================
 * Periodically fetches stored chunks from storage nodes, recomputes their
 * SHA-256 hashes, and compares them against the checksums recorded in the
 * database at upload time. Any mismatch is flagged as corruption.
 *
 * On detecting corruption:
 *   - Marks the specific replica as corrupted (is_corrupted = 1).
 *   - Emits a "corruption_detected" Socket.IO event for the dashboard.
 *   - The self-healing daemon (healer.js) will subsequently re-replicate
 *     the chunk from a healthy source, restoring the desired replica count.
 *
 * On successful verification:
 *   - Updates chunk_replicas.last_verified to the current timestamp.
 *
 * Configuration (environment variables):
 *   SCRUBBER_INTERVAL   ms between full scrub passes (default: 3,600,000 = 1 hour)
 *   SCRUBBER_BATCH_SIZE max replicas to check per pass (default: 100)
 *   SCRUBBER_STARTUP_DELAY_MS  delay before first run (default: 30,000)
 */

'use strict';

require('dotenv').config();

const fetch  = require('node-fetch');
const crypto = require('crypto');
const db     = require('../db/init');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Time between full scrub passes (ms). */
const INTERVAL = parseInt(process.env.SCRUBBER_INTERVAL, 10) || 3600000;  // 1 hour

/** Max replicas verified per scrub pass (avoids hammering nodes on large clusters). */
const BATCH_SIZE = parseInt(process.env.SCRUBBER_BATCH_SIZE, 10) || 100;

/** Delay before the first scrub run after startup (ms). */
const STARTUP_DELAY_MS = parseInt(process.env.SCRUBBER_STARTUP_DELAY_MS, 10) || 30000;

// ---------------------------------------------------------------------------
// Core scrub logic
// ---------------------------------------------------------------------------

/**
 * Verify a single chunk replica stored on a specific node.
 *
 * @param {{ id: string, checksum: string }}                         chunk
 * @param {{ id: string }}                                           replica
 * @param {{ endpoint_url: string, node_name: string, id: string }}  node
 * @param {import('socket.io').Server|null}                          io
 * @returns {Promise<'ok'|'corrupted'|'unreachable'|'error'>}
 */
async function scrubChunk(chunk, replica, node, io) {
  let buffer;

  try {
    const res = await fetch(`${node.endpoint_url}/chunks/${chunk.id}`);

    if (!res.ok) {
      console.warn(
        `[scrubber] Chunk ${chunk.id.slice(0, 8)}... unreachable on ${node.node_name} ` +
        `(HTTP ${res.status})`
      );
      return 'unreachable';
    }

    buffer = await res.buffer();
  } catch (err) {
    console.warn(
      `[scrubber] Network error reading chunk ${chunk.id.slice(0, 8)}... ` +
      `from ${node.node_name}: ${err.message}`
    );
    return 'error';
  }

  // ---- Integrity check ----
  const actualHash = crypto.createHash('sha256').update(buffer).digest('hex');

  if (actualHash !== chunk.checksum) {
    // ---- Corruption detected ----
    console.error(
      `☠️  [scrubber] CORRUPTION detected!\n` +
      `    Chunk    : ${chunk.id}\n` +
      `    Node     : ${node.node_name} (${node.endpoint_url})\n` +
      `    Expected : ${chunk.checksum}\n` +
      `    Got      : ${actualHash}`
    );

    try {
      db.prepare(`
        UPDATE chunk_replicas
        SET    is_corrupted = 1
        WHERE  id = ?
      `).run(replica.id);
    } catch (err) {
      console.error(`[scrubber] DB error marking replica ${replica.id} corrupted:`, err.message);
    }

    if (io) {
      io.emit('corruption_detected', {
        chunkId:   chunk.id,
        replicaId: replica.id,
        nodeId:    node.id,
        nodeName:  node.node_name,
        expected:  chunk.checksum,
        actual:    actualHash,
        timestamp: new Date().toISOString()
      });
    }

    return 'corrupted';
  }

  // ---- Chunk is intact — update last_verified ----
  try {
    db.prepare(`
      UPDATE chunk_replicas
      SET    last_verified = datetime('now')
      WHERE  id = ?
    `).run(replica.id);
  } catch (err) {
    console.error(`[scrubber] DB error updating last_verified for replica ${replica.id}:`, err.message);
  }

  return 'ok';
}

// ---------------------------------------------------------------------------
// Scrub pass
// ---------------------------------------------------------------------------

/**
 * Run one complete scrub pass:
 *   - Selects up to BATCH_SIZE replicas on HEALTHY nodes that haven't been
 *     verified within the last hour.
 *   - Fetches each chunk and verifies its SHA-256 hash.
 *   - Reports aggregate results via console and Socket.IO.
 *
 * @param {import('socket.io').Server|null} io
 */
async function runScrubber(io) {
  console.log('🔍 Scrubber: Starting integrity verification pass...');

  let replicas;
  try {
    replicas = db.prepare(`
      SELECT  cr.id          AS replica_id,
              cr.chunk_id,
              cr.node_id,
              cr.is_corrupted,
              c.checksum,
              n.endpoint_url,
              n.node_name,
              n.status,
              n.id           AS node_db_id
      FROM    chunk_replicas cr
      JOIN    chunks c   ON c.id  = cr.chunk_id
      JOIN    nodes  n   ON n.id  = cr.node_id
      WHERE   n.status        = 'HEALTHY'
        AND   cr.is_corrupted = 0
        AND   (
                cr.last_verified IS NULL
                OR cr.last_verified < datetime('now', '-1 hour')
              )
      LIMIT   ${BATCH_SIZE}
    `).all();
  } catch (err) {
    console.error('[scrubber] DB error fetching replicas to scrub:', err.message);
    return;
  }

  if (replicas.length === 0) {
    console.log('🔍 Scrubber: All replicas verified — nothing to check.');
    return;
  }

  console.log(`🔍 Scrubber: Checking ${replicas.length} replica(s)...`);

  let ok         = 0;
  let corrupted  = 0;
  let unreachable = 0;
  let errors     = 0;

  for (const r of replicas) {
    const result = await scrubChunk(
      { id: r.chunk_id, checksum: r.checksum },
      { id: r.replica_id },
      {
        id:           r.node_db_id,
        endpoint_url: r.endpoint_url,
        node_name:    r.node_name
      },
      io
    );

    switch (result) {
      case 'ok':          ok++;          break;
      case 'corrupted':   corrupted++;   break;
      case 'unreachable': unreachable++; break;
      default:            errors++;      break;
    }
  }

  console.log(
    `🔍 Scrubber pass done — ` +
    `✅ ${ok} ok  ☠️  ${corrupted} corrupted  📡 ${unreachable} unreachable  ❓ ${errors} errors`
  );

  if (io) {
    io.emit('scrub_complete', {
      checked:     replicas.length,
      ok,
      corrupted,
      unreachable,
      errors,
      timestamp:   new Date().toISOString()
    });
  }
}

// ---------------------------------------------------------------------------
// Daemon entry point
// ---------------------------------------------------------------------------

/**
 * Start the scrubber daemon.
 * Waits STARTUP_DELAY_MS before the first run, then repeats every INTERVAL.
 *
 * @param {import('socket.io').Server|null} io
 */
function startScrubberDaemon(io) {
  console.log(
    `🔍 Scrubber daemon started ` +
    `(interval: ${INTERVAL / 1000}s, batch: ${BATCH_SIZE}, ` +
    `startup delay: ${STARTUP_DELAY_MS / 1000}s)`
  );

  setTimeout(() => {
    // First immediate run after startup delay
    runScrubber(io).catch(err =>
      console.error('[scrubber] Unhandled error in scrub pass:', err.message)
    );

    // Recurring scheduled runs
    setInterval(() => {
      runScrubber(io).catch(err =>
        console.error('[scrubber] Unhandled error in scrub pass:', err.message)
      );
    }, INTERVAL);
  }, STARTUP_DELAY_MS);
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------
module.exports = {
  startScrubberDaemon,
  runScrubber,
  scrubChunk,
  INTERVAL,
  BATCH_SIZE,
  STARTUP_DELAY_MS
};
