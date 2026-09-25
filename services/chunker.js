/**
 * VAULT - Chunker Service
 * =======================
 * Handles splitting files into fixed-size chunks, computing checksums,
 * verifying chunk integrity, and reassembling chunks back into full files.
 *
 * Chunk size is configurable via the CHUNK_SIZE environment variable (bytes).
 * Default: 2 MiB (2,097,152 bytes)
 */

'use strict';

const crypto = require('crypto');

/** Chunk size in bytes. Override with CHUNK_SIZE env var. */
const CHUNK_SIZE = parseInt(process.env.CHUNK_SIZE, 10) || 2097152; // 2 MiB

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Split a Buffer into fixed-size chunks.
 *
 * @param {Buffer} fileBuffer   - The raw file content as a Node.js Buffer.
 * @param {string} filename     - Original filename (informational only).
 * @returns {Array<{
 *   index:    number,
 *   buffer:   Buffer,
 *   checksum: string,
 *   size:     number
 * }>} Array of chunk descriptors ordered by index.
 *
 * @example
 * const chunks = chunkFile(fs.readFileSync('video.mp4'), 'video.mp4');
 * // chunks[0].index    === 0
 * // chunks[0].checksum === 'sha256hex...'
 * // chunks[0].size     === 2097152
 */
function chunkFile(fileBuffer, filename) {
  if (!Buffer.isBuffer(fileBuffer)) {
    throw new TypeError('chunkFile: fileBuffer must be a Buffer');
  }

  const chunks = [];
  let offset = 0;
  let index  = 0;

  while (offset < fileBuffer.length) {
    const chunk    = fileBuffer.slice(offset, offset + CHUNK_SIZE);
    const checksum = crypto.createHash('sha256').update(chunk).digest('hex');

    chunks.push({
      index,
      buffer:   chunk,
      checksum,
      size:     chunk.length
    });

    offset += CHUNK_SIZE;
    index++;
  }

  // Edge case: empty buffer produces a single empty chunk
  if (chunks.length === 0) {
    const empty    = Buffer.alloc(0);
    const checksum = crypto.createHash('sha256').update(empty).digest('hex');
    chunks.push({ index: 0, buffer: empty, checksum, size: 0 });
  }

  return chunks;
}

/**
 * Compute the SHA-256 hash of an entire file buffer.
 * Used to verify end-to-end file integrity after reassembly.
 *
 * @param {Buffer} buffer - Raw file content.
 * @returns {string} Lowercase hex-encoded SHA-256 digest.
 *
 * @example
 * const hash = computeFileHash(fs.readFileSync('report.pdf'));
 * // '3a7bd3...'
 */
function computeFileHash(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError('computeFileHash: buffer must be a Buffer');
  }
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Verify a single chunk's integrity by comparing its SHA-256 against
 * the expected checksum stored in the database at upload time.
 *
 * @param {Buffer} buffer            - Raw chunk data.
 * @param {string} expectedChecksum  - Hex-encoded SHA-256 from the DB.
 * @returns {boolean} true if the chunk is intact, false if corrupted.
 *
 * @example
 * const ok = verifyChunk(chunkBuffer, chunk.checksum);
 * if (!ok) markAsCorrupted(chunk.id);
 */
function verifyChunk(buffer, expectedChecksum) {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError('verifyChunk: buffer must be a Buffer');
  }
  if (typeof expectedChecksum !== 'string') {
    throw new TypeError('verifyChunk: expectedChecksum must be a string');
  }

  const actual = crypto.createHash('sha256').update(buffer).digest('hex');
  return actual === expectedChecksum;
}

/**
 * Reassemble an ordered array of chunk Buffers into the full original file.
 * Chunks MUST be sorted by index before calling this function.
 *
 * @param {Buffer[]} chunksInOrder - Array of raw chunk Buffers in ascending index order.
 * @returns {Buffer} The reassembled file as a single contiguous Buffer.
 *
 * @example
 * const fileBuffer = assembleChunks(chunks.sort((a,b) => a.index - b.index).map(c => c.buffer));
 * fs.writeFileSync('output.pdf', fileBuffer);
 */
function assembleChunks(chunksInOrder) {
  if (!Array.isArray(chunksInOrder)) {
    throw new TypeError('assembleChunks: chunksInOrder must be an Array');
  }
  for (let i = 0; i < chunksInOrder.length; i++) {
    if (!Buffer.isBuffer(chunksInOrder[i])) {
      throw new TypeError(`assembleChunks: element at index ${i} is not a Buffer`);
    }
  }
  return Buffer.concat(chunksInOrder);
}

/**
 * Returns the configured chunk size (in bytes).
 * Useful for informational endpoints.
 *
 * @returns {number}
 */
function getChunkSize() {
  return CHUNK_SIZE;
}

/**
 * Compute a summary of chunk metadata without the binary buffers.
 * Safe to pass to JSON responses or store in a database.
 *
 * @param {Array<{ index: number, buffer: Buffer, checksum: string, size: number }>} chunks
 * @returns {Array<{ index: number, checksum: string, size: number }>}
 */
function toChunkManifest(chunks) {
  return chunks.map(({ index, checksum, size }) => ({ index, checksum, size }));
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------
module.exports = {
  chunkFile,
  computeFileHash,
  verifyChunk,
  assembleChunks,
  getChunkSize,
  toChunkManifest,
  CHUNK_SIZE
};
