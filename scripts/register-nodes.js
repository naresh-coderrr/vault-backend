'use strict';

/**
 * scripts/register-nodes.js
 *
 * One-shot script to register the three default storage nodes with the
 * running Vault Gateway.
 *
 * Prerequisites:
 *   1. The gateway server must be running:      npm start
 *   2. All three storage nodes must be running:
 *        npm run node1
 *        npm run node2
 *        npm run node3
 *
 * Usage:
 *   node scripts/register-nodes.js
 *   npm run register-nodes
 */

require('dotenv').config();
const fetch = require('node-fetch');

const GATEWAY_URL     = `http://localhost:${process.env.PORT || 3000}`;
const TEN_GB          = 10 * 1024 * 1024 * 1024; // 10 737 418 240 bytes

const NODES_TO_REGISTER = [
  {
    nodeUrl:       'http://localhost:9001',
    nodeName:      'Node Alpha',
    totalCapacity: TEN_GB,
  },
  {
    nodeUrl:       'http://localhost:9002',
    nodeName:      'Node Beta',
    totalCapacity: TEN_GB,
  },
  {
    nodeUrl:       'http://localhost:9003',
    nodeName:      'Node Gamma',
    totalCapacity: TEN_GB,
  },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Vault – Storage Node Registration Script');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  console.log(`  Gateway: ${GATEWAY_URL}`);
  console.log(`  Nodes  : ${NODES_TO_REGISTER.length}\n`);

  // Quick gateway ping before we start
  try {
    const gatewayPing = await fetch(`${GATEWAY_URL}/api/health`, { timeout: 5000 });
    if (!gatewayPing.ok) {
      console.error(`❌  Gateway health check failed (HTTP ${gatewayPing.status}).`);
      console.error('    Make sure "npm start" is running, then retry.\n');
      process.exit(1);
    }
    console.log('  ✅  Gateway is healthy.\n');
  } catch (err) {
    console.error(`❌  Cannot reach gateway at ${GATEWAY_URL}: ${err.message}`);
    console.error('    Make sure "npm start" is running, then retry.\n');
    process.exit(1);
  }

  let successCount = 0;
  let failCount    = 0;

  for (const node of NODES_TO_REGISTER) {
    process.stdout.write(`  Registering ${node.nodeName} (${node.nodeUrl}) ... `);
    try {
      const res = await fetch(`${GATEWAY_URL}/api/v1/cluster/nodes`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(node),
        timeout: 10000,
      });

      const json = await res.json().catch(() => ({}));

      if (res.status === 201) {
        console.log(`✅  Registered  (id: ${json.id})`);
        successCount += 1;
      } else if (res.status === 409) {
        console.log(`⚠️   Already registered – skipping`);
        successCount += 1;
      } else {
        console.log(`❌  HTTP ${res.status} – ${json.error || 'Unknown error'}`);
        failCount += 1;
      }
    } catch (err) {
      console.log(`❌  Request failed – ${err.message}`);
      failCount += 1;
    }
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Done.  ${successCount} succeeded, ${failCount} failed.`);

  if (failCount > 0) {
    console.log('\n  Troubleshooting tips:');
    console.log('    • Run "npm run node1", "npm run node2", "npm run node3"');
    console.log('      in separate terminals BEFORE running this script.');
    console.log('    • Check that the storage node ports (9001-9003) are free.');
    console.log('    • Ensure the gateway (npm start) started without errors.');
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
