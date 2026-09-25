'use strict';

const { v4: uuidv4 } = require('uuid');
const db = require('./init');

// ===========================================================================
// NODE QUERIES
// ===========================================================================

/**
 * Returns all nodes whose status is HEALTHY, ordered by used_capacity ASC
 * (cheapest storage first – useful for replica placement).
 */
function getHealthyNodes() {
  return db
    .prepare(
      `SELECT * FROM nodes WHERE status = 'HEALTHY' ORDER BY used_capacity ASC`
    )
    .all();
}

/**
 * Returns every node along with the count of chunk replicas stored on it.
 */
function getAllNodes() {
  return db
    .prepare(
      `SELECT n.*,
              COUNT(cr.id) AS replica_count
       FROM   nodes n
       LEFT JOIN chunk_replicas cr ON cr.node_id = n.id
       GROUP BY n.id
       ORDER BY n.created_at DESC`
    )
    .all();
}

// ===========================================================================
// FILE QUERIES
// ===========================================================================

/** Returns a single file row by primary key, or undefined. */
function getFileById(id) {
  return db.prepare(`SELECT * FROM files WHERE id = ?`).get(id);
}

/** Returns all files ordered newest-first. */
function getAllFiles() {
  return db
    .prepare(`SELECT * FROM files ORDER BY created_at DESC`)
    .all();
}

// ===========================================================================
// CHUNK QUERIES
// ===========================================================================

/** Returns all chunks belonging to a file, in sequential order. */
function getChunksByFileId(fileId) {
  return db
    .prepare(
      `SELECT * FROM chunks WHERE file_id = ? ORDER BY chunk_index ASC`
    )
    .all(fileId);
}

// ===========================================================================
// REPLICA QUERIES
// ===========================================================================

/**
 * Returns all replicas for a chunk, joined with the owning node's details.
 */
function getReplicasForChunk(chunkId) {
  return db
    .prepare(
      `SELECT cr.*, n.endpoint_url, n.node_name, n.status AS node_status
       FROM   chunk_replicas cr
       JOIN   nodes n ON n.id = cr.node_id
       WHERE  cr.chunk_id = ?`
    )
    .all(chunkId);
}

/**
 * Returns the first replica that:
 *   – is NOT corrupted (is_corrupted = 0)
 *   – lives on a HEALTHY node
 * Used during download to pick a good source.
 */
function getHealthyReplicaForChunk(chunkId) {
  return db
    .prepare(
      `SELECT cr.*, n.endpoint_url, n.node_name
       FROM   chunk_replicas cr
       JOIN   nodes n ON n.id = cr.node_id
       WHERE  cr.chunk_id    = ?
         AND  cr.is_corrupted = 0
         AND  n.status        = 'HEALTHY'
       LIMIT 1`
    )
    .get(chunkId);
}

/**
 * Finds chunks that have fewer non-corrupted, healthy replicas than the
 * file's requested replication_factor.  Returns rows with:
 *   chunk_id, file_id, chunk_index, replication_factor, healthy_replica_count
 */
function getUnderReplicatedChunks() {
  return db
    .prepare(
      `SELECT c.id            AS chunk_id,
              c.file_id,
              c.chunk_index,
              f.replication_factor,
              COUNT(CASE
                      WHEN cr.is_corrupted = 0 AND n.status = 'HEALTHY'
                      THEN 1
                    END)      AS healthy_replica_count
       FROM   chunks c
       JOIN   files  f  ON  f.id = c.file_id
       LEFT JOIN chunk_replicas cr ON cr.chunk_id = c.id
       LEFT JOIN nodes           n  ON  n.id = cr.node_id
       GROUP BY c.id
       HAVING healthy_replica_count < f.replication_factor`
    )
    .all();
}

// ===========================================================================
// INSERT HELPERS
// ===========================================================================

/**
 * Inserts a row into the `files` table.
 * @param {object} data - { id, filename, mime_type, total_size, chunk_size,
 *                          total_chunks, replication_factor, file_hash,
 *                          status, prefix }
 */
function insertFile(data) {
  const stmt = db.prepare(`
    INSERT INTO files
      (id, filename, mime_type, total_size, chunk_size, total_chunks,
       replication_factor, file_hash, status, prefix)
    VALUES
      (@id, @filename, @mime_type, @total_size, @chunk_size, @total_chunks,
       @replication_factor, @file_hash, @status, @prefix)
  `);
  return stmt.run(data);
}

/**
 * Inserts a row into the `chunks` table.
 * @param {object} data - { id, file_id, chunk_index, size, checksum }
 */
function insertChunk(data) {
  const stmt = db.prepare(`
    INSERT INTO chunks (id, file_id, chunk_index, size, checksum)
    VALUES (@id, @file_id, @chunk_index, @size, @checksum)
  `);
  return stmt.run(data);
}

/**
 * Inserts a row into the `nodes` table.
 * @param {object} data - { id, node_name, endpoint_url, total_capacity }
 */
function insertNode(data) {
  const stmt = db.prepare(`
    INSERT INTO nodes (id, node_name, endpoint_url, total_capacity)
    VALUES (@id, @node_name, @endpoint_url, @total_capacity)
  `);
  return stmt.run(data);
}

/**
 * Inserts a row into the `chunk_replicas` table.
 * @param {object} data - { id, chunk_id, node_id }
 */
function insertReplica(data) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO chunk_replicas (id, chunk_id, node_id)
    VALUES (@id, @chunk_id, @node_id)
  `);
  return stmt.run(data);
}

// ===========================================================================
// UPDATE HELPERS
// ===========================================================================

/**
 * Updates a node's status and missed_heartbeats counter.
 * @param {string} nodeId
 * @param {string} status  - 'HEALTHY' | 'DEGRADED' | 'OFFLINE'
 * @param {number} missedHeartbeats
 */
function updateNodeStatus(nodeId, status, missedHeartbeats) {
  return db
    .prepare(
      `UPDATE nodes
       SET    status             = ?,
              missed_heartbeats  = ?
       WHERE  id = ?`
    )
    .run(status, missedHeartbeats, nodeId);
}

/**
 * Records a successful heartbeat – resets missed counter and notes capacity.
 * @param {string} nodeId
 * @param {number} usedCapacity  - bytes currently in use on the node
 */
function updateNodeHeartbeat(nodeId, usedCapacity) {
  return db
    .prepare(
      `UPDATE nodes
       SET    last_heartbeat    = datetime('now'),
              used_capacity     = ?,
              missed_heartbeats = 0,
              status            = 'HEALTHY'
       WHERE  id = ?`
    )
    .run(usedCapacity, nodeId);
}

/**
 * Marks a specific replica as corrupted so the healer can recreate it.
 * @param {string} replicaId - chunk_replicas.id
 */
function markReplicaCorrupted(replicaId) {
  return db
    .prepare(
      `UPDATE chunk_replicas SET is_corrupted = 1 WHERE id = ?`
    )
    .run(replicaId);
}

/**
 * Updates the health status of a file.
 * @param {string} fileId
 * @param {string} status - 'ACTIVE' | 'DEGRADED' | 'REPAIRING' | 'CORRUPTED'
 */
function updateFileStatus(fileId, status) {
  return db
    .prepare(
      `UPDATE files
       SET status     = ?,
           updated_at = datetime('now')
       WHERE id = ?`
    )
    .run(status, fileId);
}

/**
 * Updates the used_capacity of a node.
 * @param {string} nodeId
 * @param {number} usedCapacity
 */
function updateNodeCapacity(nodeId, usedCapacity) {
  return db
    .prepare(`UPDATE nodes SET used_capacity = ? WHERE id = ?`)
    .run(usedCapacity, nodeId);
}

// ===========================================================================
// DELETE HELPERS
// ===========================================================================

/**
 * Deletes a file record (ON DELETE CASCADE removes chunks + replicas).
 * @param {string} fileId
 */
function deleteFile(fileId) {
  return db.prepare(`DELETE FROM files WHERE id = ?`).run(fileId);
}

// ===========================================================================
// ACCESS LOG
// ===========================================================================

/**
 * Appends an entry to the file_access_log table.
 * @param {string} fileId
 * @param {string} type   - e.g. 'download' | 'view'
 */
function logAccess(fileId, type = 'download') {
  return db
    .prepare(
      `INSERT INTO file_access_log (id, file_id, access_type)
       VALUES (?, ?, ?)`
    )
    .run(uuidv4(), fileId, type);
}

// ===========================================================================
// Exports
// ===========================================================================
module.exports = {
  // Node queries
  getHealthyNodes,
  getAllNodes,
  // File queries
  getFileById,
  getAllFiles,
  // Chunk queries
  getChunksByFileId,
  // Replica queries
  getReplicasForChunk,
  getHealthyReplicaForChunk,
  getUnderReplicatedChunks,
  // Inserts
  insertFile,
  insertChunk,
  insertNode,
  insertReplica,
  // Updates
  updateNodeStatus,
  updateNodeHeartbeat,
  updateNodeCapacity,
  markReplicaCorrupted,
  updateFileStatus,
  // Deletes
  deleteFile,
  // Logging
  logAccess,
};
