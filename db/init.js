'use strict';

require('dotenv').config();
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

// ---------------------------------------------------------------------------
// Open / create the SQLite database
// ---------------------------------------------------------------------------
const dbPath = process.env.DB_PATH || './vault.db';
const db = new DatabaseSync(path.resolve(dbPath));

// ---------------------------------------------------------------------------
// Performance & correctness pragmas
// ---------------------------------------------------------------------------
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// ---------------------------------------------------------------------------
// Schema initialisation
// ---------------------------------------------------------------------------
function initSchema() {
  // -- files ---------------------------------------------------------------
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id                TEXT    PRIMARY KEY,
      filename          TEXT    NOT NULL,
      mime_type         TEXT,
      total_size        INTEGER NOT NULL,
      chunk_size        INTEGER NOT NULL DEFAULT 2097152,
      total_chunks      INTEGER NOT NULL,
      replication_factor INTEGER DEFAULT 3,
      file_hash         TEXT    NOT NULL,
      status            TEXT    DEFAULT 'ACTIVE'
                                CHECK(status IN ('ACTIVE','DEGRADED','REPAIRING','CORRUPTED')),
      prefix            TEXT    DEFAULT '',
      created_at        TEXT    DEFAULT (datetime('now')),
      updated_at        TEXT    DEFAULT (datetime('now'))
    );
  `);

  // -- chunks --------------------------------------------------------------
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id          TEXT    PRIMARY KEY,
      file_id     TEXT    NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      size        INTEGER NOT NULL,
      checksum    TEXT    NOT NULL,
      created_at  TEXT    DEFAULT (datetime('now')),
      UNIQUE(file_id, chunk_index)
    );
  `);

  // -- nodes ---------------------------------------------------------------
  db.exec(`
    CREATE TABLE IF NOT EXISTS nodes (
      id               TEXT    PRIMARY KEY,
      node_name        TEXT    NOT NULL,
      endpoint_url     TEXT    NOT NULL UNIQUE,
      total_capacity   INTEGER NOT NULL DEFAULT 10737418240,
      used_capacity    INTEGER DEFAULT 0,
      status           TEXT    DEFAULT 'HEALTHY'
                               CHECK(status IN ('HEALTHY','DEGRADED','OFFLINE')),
      last_heartbeat   TEXT,
      missed_heartbeats INTEGER DEFAULT 0,
      created_at       TEXT    DEFAULT (datetime('now'))
    );
  `);

  // -- chunk_replicas -------------------------------------------------------
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunk_replicas (
      id            TEXT    PRIMARY KEY,
      chunk_id      TEXT    NOT NULL REFERENCES chunks(id)  ON DELETE CASCADE,
      node_id       TEXT    NOT NULL REFERENCES nodes(id)   ON DELETE CASCADE,
      is_corrupted  INTEGER DEFAULT 0,
      last_verified TEXT,
      created_at    TEXT    DEFAULT (datetime('now')),
      UNIQUE(chunk_id, node_id)
    );
  `);

  // -- file_versions -------------------------------------------------------
  db.exec(`
    CREATE TABLE IF NOT EXISTS file_versions (
      id         TEXT    PRIMARY KEY,
      file_id    TEXT    NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      version    INTEGER NOT NULL,
      file_hash  TEXT    NOT NULL,
      total_size INTEGER NOT NULL,
      created_at TEXT    DEFAULT (datetime('now')),
      UNIQUE(file_id, version)
    );
  `);

  // -- file_access_log -----------------------------------------------------
  db.exec(`
    CREATE TABLE IF NOT EXISTS file_access_log (
      id          TEXT PRIMARY KEY,
      file_id     TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      accessed_at TEXT DEFAULT (datetime('now')),
      access_type TEXT DEFAULT 'download'
    );
  `);

  // -- indexes -------------------------------------------------------------
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_chunks_file_id      ON chunks(file_id);
    CREATE INDEX IF NOT EXISTS idx_replicas_chunk_id   ON chunk_replicas(chunk_id);
    CREATE INDEX IF NOT EXISTS idx_replicas_node_id    ON chunk_replicas(node_id);
    CREATE INDEX IF NOT EXISTS idx_nodes_status        ON nodes(status);
    CREATE INDEX IF NOT EXISTS idx_files_status        ON files(status);
  `);

  console.log('✅  Database schema initialised successfully.');
  console.log(`📁  Database location: ${path.resolve(dbPath)}`);
}

// ---------------------------------------------------------------------------
// Run when executed directly: node db/init.js
// ---------------------------------------------------------------------------
if (require.main === module) {
  try {
    initSchema();
    process.exit(0);
  } catch (err) {
    console.error('❌  Failed to initialise database:', err.message);
    process.exit(1);
  }
} else {
  // When required as a module, run the schema silently so the tables are
  // always present before any query module tries to use them.
  initSchema();
}

module.exports = db;
