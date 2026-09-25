-- ============================================================================
-- 🗄️ VAULT PLATFORM — SUPABASE POSTGRESQL SCHEMA
-- Paste this entire script into the Supabase SQL Editor and click RUN.
-- ============================================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. FILES TABLE
CREATE TABLE IF NOT EXISTS files (
    id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    filename           VARCHAR(255) NOT NULL,
    mime_type          VARCHAR(100),
    total_size         BIGINT NOT NULL,
    chunk_size         INTEGER NOT NULL DEFAULT 2097152, -- 2MB
    total_chunks       INTEGER NOT NULL,
    replication_factor INTEGER DEFAULT 3,
    file_hash          VARCHAR(64) NOT NULL,
    status             VARCHAR(20) DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','DEGRADED','REPAIRING','CORRUPTED')),
    prefix             VARCHAR(255) DEFAULT '',
    created_at         TIMESTAMPTZ DEFAULT NOW(),
    updated_at         TIMESTAMPTZ DEFAULT NOW()
);

-- 2. CHUNKS TABLE
CREATE TABLE IF NOT EXISTS chunks (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    file_id     UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    size        BIGINT NOT NULL,
    checksum    VARCHAR(64) NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(file_id, chunk_index)
);

-- 3. NODES TABLE
CREATE TABLE IF NOT EXISTS nodes (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    node_name         VARCHAR(100) NOT NULL,
    endpoint_url      VARCHAR(255) NOT NULL UNIQUE,
    total_capacity    BIGINT NOT NULL DEFAULT 10737418240, -- 10GB
    used_capacity     BIGINT DEFAULT 0,
    status            VARCHAR(20) DEFAULT 'HEALTHY' CHECK(status IN ('HEALTHY','DEGRADED','OFFLINE')),
    last_heartbeat    TIMESTAMPTZ,
    missed_heartbeats INTEGER DEFAULT 0,
    created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- 4. CHUNK REPLICAS TABLE
CREATE TABLE IF NOT EXISTS chunk_replicas (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    chunk_id      UUID NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
    node_id       UUID NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    is_corrupted  BOOLEAN DEFAULT FALSE,
    last_verified TIMESTAMPTZ,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(chunk_id, node_id)
);

-- 5. FILE VERSIONS TABLE
CREATE TABLE IF NOT EXISTS file_versions (
    id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    file_id    UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    version    INTEGER NOT NULL,
    file_hash  VARCHAR(64) NOT NULL,
    total_size BIGINT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(file_id, version)
);

-- 6. FILE ACCESS LOG TABLE
CREATE TABLE IF NOT EXISTS file_access_log (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    file_id     UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    accessed_at TIMESTAMPTZ DEFAULT NOW(),
    access_type VARCHAR(20) DEFAULT 'download'
);

-- INDEXES FOR MAXIMUM QUERY SPEED
CREATE INDEX IF NOT EXISTS idx_chunks_file_id      ON chunks(file_id);
CREATE INDEX IF NOT EXISTS idx_replicas_chunk_id   ON chunk_replicas(chunk_id);
CREATE INDEX IF NOT EXISTS idx_replicas_node_id    ON chunk_replicas(node_id);
CREATE INDEX IF NOT EXISTS idx_nodes_status        ON nodes(status);
CREATE INDEX IF NOT EXISTS idx_files_status        ON files(status);

-- Enable Row Level Security (RLS) policies (Optional, public read for dashboard)
ALTER TABLE files ENABLE ROW LEVEL SECURITY;
ALTER TABLE chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE chunk_replicas ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public Read Files" ON files FOR SELECT USING (true);
CREATE POLICY "Public Read Chunks" ON chunks FOR SELECT USING (true);
CREATE POLICY "Public Read Nodes" ON nodes FOR SELECT USING (true);
CREATE POLICY "Public Read Replicas" ON chunk_replicas FOR SELECT USING (true);
