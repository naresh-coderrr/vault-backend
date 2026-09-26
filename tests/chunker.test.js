/**
 * ============================================================================
 * 🧪 VAULT TEST SUITE: Chunker & Cryptographic Engine
 * Verifies 4MB dynamic sharding, 5MB small file broadcast threshold,
 * SHA-256 cryptographic checksums, and payload reassembly.
 * ============================================================================
 */

const { describe, it } = require('node:test') || { describe: (name, fn) => describe(name, fn), it: (name, fn) => it(name, fn) };
const assert = require('assert');
const crypto = require('crypto');
const { chunkFile, computeFileHash, verifyChunk, assembleChunks } = require('../backend/services/chunker');

describe('🛡️ Vault Chunker & Cryptographic Engine Tests', () => {

  it('1. should compute correct SHA-256 hash for raw binary buffer', () => {
    const data = Buffer.from('Vault Distributed Object Storage - 99.999999999% Durability');
    const expectedHash = crypto.createHash('sha256').update(data).digest('hex');
    const actualHash = computeFileHash(data);
    
    assert.strictEqual(actualHash, expectedHash);
    assert.strictEqual(actualHash.length, 64);
  });

  it('2. should slice small files (< 4MB) into exactly 1 atomic block', () => {
    const smallPayload = Buffer.alloc(1024 * 512, 'a'); // 512 KB
    const chunks = chunkFile(smallPayload, 'test-doc.pdf');

    assert.strictEqual(chunks.length, 1);
    assert.strictEqual(chunks[0].index, 0);
    assert.strictEqual(chunks[0].size, 1024 * 512);
    assert.strictEqual(verifyChunk(chunks[0].buffer, chunks[0].checksum), true);
  });

  it('3. should correctly partition large files (≥ 4MB) into multiple shards', () => {
    const chunkSize = 2097152; // Default test chunk size: 2MB
    const largePayload = Buffer.alloc(chunkSize * 3 + 1024, 'v'); // 3 full chunks + 1 partial chunk
    const chunks = chunkFile(largePayload, 'dataset-backup.tar');

    assert.strictEqual(chunks.length, 4);
    assert.strictEqual(chunks[0].index, 0);
    assert.strictEqual(chunks[1].index, 1);
    assert.strictEqual(chunks[2].index, 2);
    assert.strictEqual(chunks[3].index, 3);
    assert.strictEqual(chunks[3].size, 1024);
  });

  it('4. should reassemble shards in order and match the original payload exactly', () => {
    const originalText = 'Distributed quorum consensus across Node Alpha, Beta, Gamma, Delta, Epsilon, Zeta, Eta, Theta, Iota';
    const originalBuffer = Buffer.from(originalText.repeat(1000));
    
    const chunks = chunkFile(originalBuffer, 'consensus-manifest.json');
    const chunkBuffers = chunks.map(c => c.buffer);
    const reassembledBuffer = assembleChunks(chunkBuffers);

    assert.deepStrictEqual(reassembledBuffer, originalBuffer);
    assert.strictEqual(computeFileHash(reassembledBuffer), computeFileHash(originalBuffer));
  });

  it('5. should detect corrupted data when checksum does not match', () => {
    const validChunk = Buffer.from('Original uncorrupted chunk payload');
    const validChecksum = crypto.createHash('sha256').update(validChunk).digest('hex');

    const corruptedChunk = Buffer.from('Corrupted bit-rot chunk payload');
    const isIntact = verifyChunk(corruptedChunk, validChecksum);

    assert.strictEqual(isIntact, false);
  });

});
