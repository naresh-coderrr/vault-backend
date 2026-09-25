'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/init');

const CHUNK_SIZE = 2 * 1024 * 1024; // 2MB

// Ensure node directories exist
const NODES = [
  { id: 'node-alpha-9001', name: 'Node Alpha', endpoint: 'http://localhost:9001', dir: path.resolve('./node_data/node1'), capacity: 10737418240 },
  { id: 'node-beta-9002',  name: 'Node Beta',  endpoint: 'http://localhost:9002', dir: path.resolve('./node_data/node2'), capacity: 10737418240 },
  { id: 'node-gamma-9003', name: 'Node Gamma', endpoint: 'http://localhost:9003', dir: path.resolve('./node_data/node3'), capacity: 10737418240 }
];

NODES.forEach(n => {
  if (!fs.existsSync(n.dir)) {
    fs.mkdirSync(n.dir, { recursive: true });
  }
});

// Clear existing tables for fresh seed
db.exec('DELETE FROM chunk_replicas;');
db.exec('DELETE FROM chunks;');
db.exec('DELETE FROM file_versions;');
db.exec('DELETE FROM file_access_log;');
db.exec('DELETE FROM files;');
db.exec('DELETE FROM nodes;');

// Insert nodes
const insertNodeStmt = db.prepare(`
  INSERT INTO nodes (id, node_name, endpoint_url, total_capacity, used_capacity, status, last_heartbeat)
  VALUES (?, ?, ?, ?, ?, 'HEALTHY', datetime('now'))
`);

NODES.forEach(n => {
  insertNodeStmt.run(n.id, n.name, n.endpoint, n.capacity, 0);
});

// Generate sample file contents of various sizes
function generateBuffer(sizeInBytes, patternSeed) {
  const buf = Buffer.alloc(sizeInBytes);
  const pattern = Buffer.from(`VaultStorage_Seed_${patternSeed}_DataChunk_Binary_Header_Payload_Block_`);
  for (let i = 0; i < sizeInBytes; i++) {
    buf[i] = pattern[i % pattern.length] ^ (i & 0xFF);
  }
  return buf;
}

const SAMPLE_FILES = [
  {
    filename: 'system_architecture_manifest.json',
    mime_type: 'application/json',
    size: 14850, // ~15 KB (Small)
    replication_factor: 3,
    status: 'ACTIVE',
    seed: 'json_config'
  },
  {
    filename: 'cloud_security_audit_report.pdf',
    mime_type: 'application/pdf',
    size: 845200, // ~845 KB (Medium)
    replication_factor: 3,
    status: 'ACTIVE',
    seed: 'sec_pdf'
  },
  {
    filename: 'cluster_datacenter_map.png',
    mime_type: 'image/png',
    size: 2450000, // ~2.45 MB (Medium - 2 Chunks)
    replication_factor: 3,
    status: 'ACTIVE',
    seed: 'dc_image'
  },
  {
    filename: 'financial_ledger_2025.zip',
    mime_type: 'application/zip',
    size: 8650000, // ~8.65 MB (Large - 5 Chunks)
    replication_factor: 3,
    status: 'ACTIVE',
    seed: 'fin_ledger'
  },
  {
    filename: 'enterprise_backup_q3.tar.gz',
    mime_type: 'application/gzip',
    size: 14200000, // ~14.2 MB (Large - 7 Chunks)
    replication_factor: 3,
    status: 'DEGRADED', // One file marked DEGRADED to demonstrate resilience!
    seed: 'tar_backup'
  },
  {
    filename: 'quantum_ml_weights_v4.bin',
    mime_type: 'application/octet-stream',
    size: 24800000, // ~24.8 MB (Very Large - 12 Chunks)
    replication_factor: 3,
    status: 'ACTIVE',
    seed: 'ml_weights'
  }
];

const insertFileStmt = db.prepare(`
  INSERT INTO files (id, filename, mime_type, total_size, chunk_size, total_chunks, replication_factor, file_hash, status, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?))
`);

const insertChunkStmt = db.prepare(`
  INSERT INTO chunks (id, file_id, chunk_index, size, checksum, created_at)
  VALUES (?, ?, ?, ?, ?, datetime('now'))
`);

const insertReplicaStmt = db.prepare(`
  INSERT INTO chunk_replicas (id, chunk_id, node_id, is_corrupted, last_verified, created_at)
  VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
`);

const updateNodeUsageStmt = db.prepare(`
  UPDATE nodes SET used_capacity = used_capacity + ? WHERE id = ?
`);

console.log('🌱 Seeding database with real-world files of small to large sizes...');

SAMPLE_FILES.forEach((f, idx) => {
  const fileId = uuidv4();
  const fileBuffer = generateBuffer(f.size, f.seed);
  const fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
  const totalChunks = Math.ceil(f.size / CHUNK_SIZE);

  // Time offset so created_at dates vary naturally
  const timeOffset = `-${idx * 2} hours`;
  insertFileStmt.run(fileId, f.filename, f.mime_type, f.size, CHUNK_SIZE, totalChunks, f.replication_factor, fileHash, f.status, timeOffset);

  let offset = 0;
  for (let chunkIdx = 0; chunkIdx < totalChunks; chunkIdx++) {
    const chunkId = uuidv4();
    const chunkBuffer = fileBuffer.slice(offset, offset + CHUNK_SIZE);
    const checksum = crypto.createHash('sha256').update(chunkBuffer).digest('hex');

    insertChunkStmt.run(chunkId, fileId, chunkIdx, chunkBuffer.length, checksum);

    // Replicate across 3 nodes
    NODES.forEach((node, nIdx) => {
      // If file status is DEGRADED, omit replica on Node 3 for chunk 0
      if (f.status === 'DEGRADED' && nIdx === 2 && chunkIdx === 0) {
        return; // Skip replica to simulate missing copy
      }

      const replicaId = uuidv4();
      insertReplicaStmt.run(replicaId, chunkId, node.id, 0);
      updateNodeUsageStmt.run(chunkBuffer.length, node.id);

      // Write physical file to node directory
      const physicalChunkPath = path.join(node.dir, chunkId);
      fs.writeFileSync(physicalChunkPath, chunkBuffer);
    });

    offset += CHUNK_SIZE;
  }

  console.log(`  ✅ Seeded: ${f.filename} (${(f.size / (1024 * 1024)).toFixed(2)} MB, ${totalChunks} chunks)`);
});

console.log('\n🎉 Real database seeding complete!');
console.log('📊 Summary:');
console.log(`   Files: ${db.prepare('SELECT COUNT(*) as c FROM files').get().c}`);
console.log(`   Chunks: ${db.prepare('SELECT COUNT(*) as c FROM chunks').get().c}`);
console.log(`   Replicas: ${db.prepare('SELECT COUNT(*) as c FROM chunk_replicas').get().c}`);
console.log(`   Nodes: ${db.prepare('SELECT COUNT(*) as c FROM nodes').get().c}`);
