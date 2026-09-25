'use strict';

require('dotenv').config();
const { supabase, isSupabaseConfigured } = require('../db/supabase');
const crypto = require('crypto');

if (!isSupabaseConfigured()) {
  console.error('❌ Supabase credentials not found in .env!');
  console.log('   Please set SUPABASE_URL and SUPABASE_ANON_KEY in your .env file.');
  process.exit(1);
}

const CHUNK_SIZE = 2 * 1024 * 1024;

const SAMPLE_FILES = [
  { filename: 'system_architecture_manifest.json', mime_type: 'application/json', size: 14850, replication_factor: 3, status: 'ACTIVE' },
  { filename: 'cloud_security_audit_report.pdf', mime_type: 'application/pdf', size: 845200, replication_factor: 3, status: 'ACTIVE' },
  { filename: 'cluster_datacenter_map.png', mime_type: 'image/png', size: 2450000, replication_factor: 3, status: 'ACTIVE' },
  { filename: 'financial_ledger_2025.zip', mime_type: 'application/zip', size: 8650000, replication_factor: 3, status: 'ACTIVE' },
  { filename: 'enterprise_backup_q3.tar.gz', mime_type: 'application/gzip', size: 14200000, replication_factor: 3, status: 'DEGRADED' },
  { filename: 'quantum_ml_weights_v4.bin', mime_type: 'application/octet-stream', size: 24800000, replication_factor: 3, status: 'ACTIVE' }
];

async function seedSupabase() {
  console.log('🚀 Seeding Supabase database with real-world files...');

  // 1. Register Nodes in Supabase
  const nodes = [
    { node_name: 'Node Alpha', endpoint_url: 'http://localhost:9001', total_capacity: 10737418240, status: 'HEALTHY' },
    { node_name: 'Node Beta',  endpoint_url: 'http://localhost:9002', total_capacity: 10737418240, status: 'HEALTHY' },
    { node_name: 'Node Gamma', endpoint_url: 'http://localhost:9003', total_capacity: 10737418240, status: 'HEALTHY' }
  ];

  const { data: nodeData, error: nodeErr } = await supabase.from('nodes').upsert(nodes, { onConflict: 'endpoint_url' }).select();
  if (nodeErr) {
    console.error('❌ Error inserting nodes:', nodeErr.message);
    return;
  }
  console.log(`✅ ${nodeData.length} Nodes registered in Supabase.`);

  // 2. Insert Files & Chunks into Supabase
  for (const f of SAMPLE_FILES) {
    const dummyHash = crypto.createHash('sha256').update(f.filename + f.size).digest('hex');
    const totalChunks = Math.ceil(f.size / CHUNK_SIZE);

    const { data: fileRes, error: fileErr } = await supabase.from('files').insert({
      filename: f.filename,
      mime_type: f.mime_type,
      total_size: f.size,
      chunk_size: CHUNK_SIZE,
      total_chunks: totalChunks,
      replication_factor: f.replication_factor,
      file_hash: dummyHash,
      status: f.status
    }).select().single();

    if (fileErr) {
      console.error(`❌ File insert error (${f.filename}):`, fileErr.message);
      continue;
    }

    console.log(`  ✅ File added to Supabase: ${f.filename} (ID: ${fileRes.id})`);

    // Insert chunks
    for (let cIdx = 0; cIdx < totalChunks; cIdx++) {
      const chunkHash = crypto.createHash('sha256').update(`${fileRes.id}_chunk_${cIdx}`).digest('hex');
      const chunkSize = (cIdx === totalChunks - 1) ? (f.size % CHUNK_SIZE || CHUNK_SIZE) : CHUNK_SIZE;

      const { data: chunkRes, error: chunkErr } = await supabase.from('chunks').insert({
        file_id: fileRes.id,
        chunk_index: cIdx,
        size: chunkSize,
        checksum: chunkHash
      }).select().single();

      if (chunkErr) continue;

      // Insert replicas across nodes
      for (const node of nodeData) {
        if (f.status === 'DEGRADED' && node.node_name === 'Node Gamma' && cIdx === 0) continue;

        await supabase.from('chunk_replicas').insert({
          chunk_id: chunkRes.id,
          node_id: node.id,
          is_corrupted: false
        });
      }
    }
  }

  console.log('\n🎉 Supabase seeding finished successfully!');
}

seedSupabase();
