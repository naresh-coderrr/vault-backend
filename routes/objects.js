'use strict';

/**
 * routes/objects.js
 *
 * Handles all object (file) CRUD operations:
 *   POST   /api/v1/objects/upload   – stream a file into the cluster
 *   GET    /api/v1/objects          – list all stored objects
 *   GET    /api/v1/objects/:id      – metadata + chunk breakdown
 *   GET    /api/v1/objects/:id/download – reassemble & stream back
 *   DELETE /api/v1/objects/:id      – purge from cluster + DB
 */

const express = require('express');
const multer  = require('multer');
const crypto  = require('crypto');
const fetch   = require('node-fetch');
const { v4: uuidv4 } = require('uuid');

const router = express.Router();

// Multer – keep file in memory (we need the Buffer for chunking)
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: parseInt(process.env.MAX_UPLOAD_SIZE, 10) || 10 * 1024 * 1024 * 1024 },
});

const q = require('../db/queries');
const { chunkFile, DEFAULT_CHUNK_SIZE } = require('../services/chunker');

// Lazy-load io to avoid circular-require issues at startup
function getIo() {
  return require('../server').io;
}

// ---------------------------------------------------------------------------
// Helper: POST a chunk Buffer to a storage node
// ---------------------------------------------------------------------------
async function sendChunkToNode(nodeUrl, chunkId, chunkBuffer) {
  const url = `${nodeUrl}/chunks/${chunkId}`;
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body:    chunkBuffer,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Node ${nodeUrl} rejected chunk ${chunkId}: ${res.status} ${body}`);
  }
  return res;
}

// ---------------------------------------------------------------------------
// Helper: DELETE a chunk from a storage node (best-effort)
// ---------------------------------------------------------------------------
async function deleteChunkFromNode(nodeUrl, chunkId) {
  try {
    const res = await fetch(`${nodeUrl}/chunks/${chunkId}`, { method: 'DELETE' });
    if (!res.ok) {
      console.warn(`[objects] DELETE chunk ${chunkId} on ${nodeUrl}: HTTP ${res.status}`);
    }
  } catch (err) {
    console.warn(`[objects] Could not reach ${nodeUrl} to delete chunk ${chunkId}: ${err.message}`);
  }
}

// ===========================================================================
// POST /api/v1/objects/upload
// ===========================================================================
router.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file provided (field name: "file")' });
  }

  const io = getIo();
  const replicationFactor = Math.max(1, parseInt(req.body.replicationFactor, 10) || 3);
  const prefix = (req.body.prefix || '').trim();

  try {
    const fileBuffer  = req.file.buffer;
    const filename    = req.file.originalname;
    const mimeType    = req.file.mimetype || 'application/octet-stream';
    const totalSize   = fileBuffer.length;

    // ---- 1. Split into chunks ---------------------------------------------
    const chunks = chunkFile(fileBuffer, filename);
    const totalChunks = chunks.length;

    // ---- 2. Compute whole-file SHA-256 -------------------------------------
    const fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');

    // ---- 3. Insert file record --------------------------------------------
    const fileId = uuidv4();
    q.insertFile({
      id:                 fileId,
      filename,
      mime_type:          mimeType,
      total_size:         totalSize,
      chunk_size:         DEFAULT_CHUNK_SIZE,
      total_chunks:       totalChunks,
      replication_factor: replicationFactor,
      file_hash:          fileHash,
      status:             'ACTIVE',
      prefix,
    });

    // ---- 4. Distribute chunks across healthy nodes -------------------------
    const healthyNodes = q.getHealthyNodes(); // sorted by used_capacity ASC
    if (healthyNodes.length === 0) {
      return res.status(503).json({ error: 'No healthy storage nodes available' });
    }
    const effectiveReplicas = Math.min(replicationFactor, healthyNodes.length);

    const chunkResults = [];

    for (const chunk of chunks) {
      const chunkId = uuidv4();

      // Insert chunk metadata
      q.insertChunk({
        id:          chunkId,
        file_id:     fileId,
        chunk_index: chunk.index,
        size:        chunk.size,
        checksum:    chunk.checksum,
      });

      // Pick the N least-used nodes for this chunk
      // Re-fetch nodes each iteration so capacity updates are reflected
      const candidates = q.getHealthyNodes().slice(0, effectiveReplicas);
      const successNodes = [];

      for (const node of candidates) {
        try {
          await sendChunkToNode(node.endpoint_url, chunkId, chunk.buffer);

          // Record the replica
          q.insertReplica({
            id:       uuidv4(),
            chunk_id: chunkId,
            node_id:  node.id,
          });

          // Optimistically update in-memory capacity (the node will report
          // exact value on its next heartbeat)
          q.updateNodeCapacity(node.id, (node.used_capacity || 0) + chunk.size);

          successNodes.push(node.id);

          io.emit('upload_progress', {
            fileId,
            chunkIndex:  chunk.index,
            totalChunks,
            nodeId:      node.id,
            nodeName:    node.node_name,
          });
        } catch (err) {
          console.error(`[upload] Failed to place chunk ${chunk.index} on node ${node.node_name}:`, err.message);
        }
      }

      chunkResults.push({ chunkId, chunkIndex: chunk.index, replicas: successNodes });
    }

    io.emit('file_uploaded', { fileId, filename });

    // ---- 5. Return full file metadata ------------------------------------
    return res.status(201).json({
      id:                 fileId,
      filename,
      mime_type:          mimeType,
      total_size:         totalSize,
      chunk_size:         DEFAULT_CHUNK_SIZE,
      total_chunks:       totalChunks,
      replication_factor: replicationFactor,
      file_hash:          fileHash,
      status:             'ACTIVE',
      prefix,
      chunks:             chunkResults,
    });
  } catch (err) {
    console.error('[upload] Unhandled error:', err);
    return res.status(500).json({ error: 'Upload failed', detail: err.message });
  }
});

// ===========================================================================
// GET /api/v1/objects  –  list all files
// ===========================================================================
router.get('/', (_req, res) => {
  try {
    const files = q.getAllFiles();

    // Augment each file with a quick replica health summary
    const result = files.map((file) => {
      const chunks   = q.getChunksByFileId(file.id);
      let healthyReplicas = 0;
      let totalReplicas   = 0;

      for (const chunk of chunks) {
        const replicas = q.getReplicasForChunk(chunk.id);
        totalReplicas  += replicas.length;
        healthyReplicas += replicas.filter(
          (r) => r.is_corrupted === 0 && r.node_status === 'HEALTHY'
        ).length;
      }

      return {
        ...file,
        replica_health: {
          total_replicas:   totalReplicas,
          healthy_replicas: healthyReplicas,
          total_chunks:     chunks.length,
        },
      };
    });

    return res.json(result);
  } catch (err) {
    console.error('[list files] Error:', err);
    return res.status(500).json({ error: 'Failed to retrieve files', detail: err.message });
  }
});

// ===========================================================================
// GET /api/v1/objects/:id  –  single file with chunk breakdown
// ===========================================================================
router.get('/:id', (req, res) => {
  try {
    const file = q.getFileById(req.params.id);
    if (!file) return res.status(404).json({ error: 'File not found' });

    const chunks = q.getChunksByFileId(file.id);
    const chunkDetails = chunks.map((chunk) => {
      const replicas = q.getReplicasForChunk(chunk.id);
      return {
        ...chunk,
        replicas: replicas.map((r) => ({
          id:          r.id,
          node_id:     r.node_id,
          node_name:   r.node_name,
          node_status: r.node_status,
          is_corrupted: r.is_corrupted === 1,
          last_verified: r.last_verified,
        })),
      };
    });

    return res.json({ ...file, chunks: chunkDetails });
  } catch (err) {
    console.error('[get file] Error:', err);
    return res.status(500).json({ error: 'Failed to retrieve file', detail: err.message });
  }
});

// ===========================================================================
// GET /api/v1/objects/:id/download
// ===========================================================================
router.get('/:id/download', async (req, res) => {
  try {
    const file = q.getFileById(req.params.id);
    if (!file) return res.status(404).json({ error: 'File not found' });

    const chunks = q.getChunksByFileId(file.id);
    if (chunks.length === 0) {
      return res.status(500).json({ error: 'File has no chunks recorded' });
    }

    const assembledBuffers = [];

    for (const chunk of chunks) {
      const replica = q.getHealthyReplicaForChunk(chunk.id);
      if (!replica) {
        return res.status(503).json({
          error: `No healthy replica available for chunk ${chunk.chunk_index}`,
        });
      }

      // Fetch from node
      const nodeRes = await fetch(`${replica.endpoint_url}/chunks/${chunk.id}`);
      if (!nodeRes.ok) {
        return res.status(502).json({
          error: `Failed to retrieve chunk ${chunk.chunk_index} from node ${replica.node_name}`,
        });
      }

      const chunkBuf = await nodeRes.buffer();

      // Verify integrity
      const actualChecksum = crypto
        .createHash('sha256')
        .update(chunkBuf)
        .digest('hex');

      if (actualChecksum !== chunk.checksum) {
        console.error(
          `[download] Checksum mismatch for chunk ${chunk.chunk_index} on ${replica.node_name}`
        );
        // Mark replica as corrupted so the healer can fix it
        const replicas = q.getReplicasForChunk(chunk.id);
        const badReplica = replicas.find((r) => r.node_id === replica.node_id);
        if (badReplica) q.markReplicaCorrupted(badReplica.id);

        return res.status(500).json({
          error: `Integrity check failed for chunk ${chunk.chunk_index}`,
        });
      }

      assembledBuffers.push(chunkBuf);
    }

    // Reassemble
    const fileBuffer = Buffer.concat(assembledBuffers);

    // Log the access
    q.logAccess(file.id, 'download');

    // Stream back to client
    res.set('Content-Type', file.mime_type || 'application/octet-stream');
    res.set(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(file.filename)}"`
    );
    res.set('Content-Length', String(fileBuffer.length));
    return res.send(fileBuffer);
  } catch (err) {
    console.error('[download] Unhandled error:', err);
    return res.status(500).json({ error: 'Download failed', detail: err.message });
  }
});

// ===========================================================================
// DELETE /api/v1/objects/:id
// ===========================================================================
router.delete('/:id', async (req, res) => {
  try {
    const file = q.getFileById(req.params.id);
    if (!file) return res.status(404).json({ error: 'File not found' });

    const chunks = q.getChunksByFileId(file.id);

    // Best-effort: remove every replica from its storage node
    for (const chunk of chunks) {
      const replicas = q.getReplicasForChunk(chunk.id);
      await Promise.all(
        replicas.map((r) => deleteChunkFromNode(r.endpoint_url, chunk.id))
      );
    }

    // Remove from DB (cascades to chunks + replicas)
    q.deleteFile(file.id);

    const io = getIo();
    io.emit('file_deleted', { fileId: file.id, filename: file.filename });

    return res.status(204).send();
  } catch (err) {
    console.error('[delete] Unhandled error:', err);
    return res.status(500).json({ error: 'Delete failed', detail: err.message });
  }
});

module.exports = router;
