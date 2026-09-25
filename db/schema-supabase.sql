-- ============================================================================
-- 🛡️ VAULT DISTRIBUTED OBJECT STORAGE — COMPLETE SUPABASE SETUP SCRIPT
-- Paste this entire script into your Supabase SQL Editor and click "RUN".
-- Project: https://csrhmocmponregwceknr.supabase.co
-- ============================================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. FILES TABLE (Object Catalog & Global Hashes)
CREATE TABLE IF NOT EXISTS public.files (
    id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    filename           VARCHAR(255) NOT NULL,
    mime_type          VARCHAR(100),
    total_size         BIGINT NOT NULL,
    chunk_size         INTEGER NOT NULL DEFAULT 4194304, -- 4MB
    total_chunks       INTEGER NOT NULL DEFAULT 1,
    replication_factor INTEGER DEFAULT 3,
    file_hash          VARCHAR(64) NOT NULL,
    status             VARCHAR(20) DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','DEGRADED','REPAIRING','CORRUPTED')),
    prefix             VARCHAR(255) DEFAULT '',
    created_at         TIMESTAMPTZ DEFAULT NOW(),
    updated_at         TIMESTAMPTZ DEFAULT NOW()
);

-- 2. CHUNKS TABLE (Physical Shard Checksums)
CREATE TABLE IF NOT EXISTS public.chunks (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    file_id     UUID NOT NULL REFERENCES public.files(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    size        BIGINT NOT NULL,
    checksum    VARCHAR(64) NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(file_id, chunk_index)
);

-- 3. STORAGE NODES TABLE (9-Node Multi-Zone Telemetry)
CREATE TABLE IF NOT EXISTS public.nodes (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    node_name         VARCHAR(100) NOT NULL,
    endpoint_url      VARCHAR(255) NOT NULL UNIQUE,
    zone              VARCHAR(50) DEFAULT 'us-east-1a',
    total_capacity    BIGINT NOT NULL DEFAULT 10737418240, -- 10GB
    used_capacity     BIGINT DEFAULT 0,
    status            VARCHAR(20) DEFAULT 'HEALTHY' CHECK(status IN ('HEALTHY','DEGRADED','OFFLINE')),
    last_heartbeat    TIMESTAMPTZ DEFAULT NOW(),
    missed_heartbeats INTEGER DEFAULT 0,
    created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- 4. CHUNK REPLICAS TABLE (Placement Matrix)
CREATE TABLE IF NOT EXISTS public.chunk_replicas (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    chunk_id      UUID NOT NULL REFERENCES public.chunks(id) ON DELETE CASCADE,
    node_id       UUID NOT NULL REFERENCES public.nodes(id) ON DELETE CASCADE,
    is_corrupted  BOOLEAN DEFAULT FALSE,
    last_verified TIMESTAMPTZ DEFAULT NOW(),
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(chunk_id, node_id)
);

-- 5. FILE VERSIONS TABLE (Immutable History)
CREATE TABLE IF NOT EXISTS public.file_versions (
    id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    file_id    UUID NOT NULL REFERENCES public.files(id) ON DELETE CASCADE,
    version    INTEGER NOT NULL,
    file_hash  VARCHAR(64) NOT NULL,
    total_size BIGINT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(file_id, version)
);

-- 6. ACCESS LOG TABLE (Audit Trail)
CREATE TABLE IF NOT EXISTS public.file_access_log (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    file_id     UUID NOT NULL REFERENCES public.files(id) ON DELETE CASCADE,
    accessed_at TIMESTAMPTZ DEFAULT NOW(),
    access_type VARCHAR(20) DEFAULT 'download'
);

-- INDEXES FOR MAXIMUM QUERY SPEED
CREATE INDEX IF NOT EXISTS idx_chunks_file_id      ON public.chunks(file_id);
CREATE INDEX IF NOT EXISTS idx_replicas_chunk_id   ON public.chunk_replicas(chunk_id);
CREATE INDEX IF NOT EXISTS idx_replicas_node_id    ON public.chunk_replicas(node_id);
CREATE INDEX IF NOT EXISTS idx_nodes_status        ON public.nodes(status);
CREATE INDEX IF NOT EXISTS idx_files_status        ON public.files(status);

-- 7. ENABLE ROW LEVEL SECURITY WITH FULL PUBLIC ACCESS (FOR VAULT APP)
ALTER TABLE public.files ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chunk_replicas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.file_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.file_access_log ENABLE ROW LEVEL SECURITY;

-- Allow read/write for all users (anon & authenticated)
DO $$
BEGIN
    DROP POLICY IF EXISTS "Allow All Files" ON public.files;
    CREATE POLICY "Allow All Files" ON public.files FOR ALL USING (true) WITH CHECK (true);

    DROP POLICY IF EXISTS "Allow All Chunks" ON public.chunks;
    CREATE POLICY "Allow All Chunks" ON public.chunks FOR ALL USING (true) WITH CHECK (true);

    DROP POLICY IF EXISTS "Allow All Nodes" ON public.nodes;
    CREATE POLICY "Allow All Nodes" ON public.nodes FOR ALL USING (true) WITH CHECK (true);

    DROP POLICY IF EXISTS "Allow All Replicas" ON public.chunk_replicas;
    CREATE POLICY "Allow All Replicas" ON public.chunk_replicas FOR ALL USING (true) WITH CHECK (true);

    DROP POLICY IF EXISTS "Allow All Versions" ON public.file_versions;
    CREATE POLICY "Allow All Versions" ON public.file_versions FOR ALL USING (true) WITH CHECK (true);

    DROP POLICY IF EXISTS "Allow All Logs" ON public.file_access_log;
    CREATE POLICY "Allow All Logs" ON public.file_access_log FOR ALL USING (true) WITH CHECK (true);
END $$;

-- 8. CREATE STORAGE BUCKET 'vault-files' IN SUPABASE STORAGE
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('vault-files', 'vault-files', true, 1073741824, NULL)
ON CONFLICT (id) DO UPDATE SET public = true;

-- Storage RLS policy allowing public upload and download
DO $$
BEGIN
    DROP POLICY IF EXISTS "Public Storage Upload" ON storage.objects;
    CREATE POLICY "Public Storage Upload" ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'vault-files');

    DROP POLICY IF EXISTS "Public Storage Download" ON storage.objects;
    CREATE POLICY "Public Storage Download" ON storage.objects FOR SELECT USING (bucket_id = 'vault-files');
END $$;

-- 9. PRE-SEED 9 STORAGE NODES INTO SUPABASE
INSERT INTO public.nodes (id, node_name, endpoint_url, zone, total_capacity, used_capacity, status)
VALUES
    ('00000000-0000-0000-0000-000000000001', 'Node Alpha',   'http://127.0.0.1:9001', 'us-east-1a (Rack-01)', 10737418240, 53477376, 'HEALTHY'),
    ('00000000-0000-0000-0000-000000000002', 'Node Beta',    'http://127.0.0.1:9002', 'us-east-1b (Rack-01)', 10737418240, 53477376, 'HEALTHY'),
    ('00000000-0000-0000-0000-000000000003', 'Node Gamma',   'http://127.0.0.1:9003', 'us-east-1c (Rack-02)', 10737418240, 49283072, 'HEALTHY'),
    ('00000000-0000-0000-0000-000000000004', 'Node Delta',   'http://127.0.0.1:9004', 'us-west-2a (Rack-02)', 10737418240, 41943040, 'HEALTHY'),
    ('00000000-0000-0000-0000-000000000005', 'Node Epsilon', 'http://127.0.0.1:9005', 'us-west-2b (Rack-03)', 10737418240, 37748736, 'HEALTHY'),
    ('00000000-0000-0000-0000-000000000006', 'Node Zeta',    'http://127.0.0.1:9006', 'eu-central-1a (Rack-03)', 10737418240, 37748736, 'HEALTHY'),
    ('00000000-0000-0000-0000-000000000007', 'Node Eta',     'http://127.0.0.1:9007', 'eu-central-1b (Rack-04)', 10737418240, 33554432, 'HEALTHY'),
    ('00000000-0000-0000-0000-000000000008', 'Node Theta',   'http://127.0.0.1:9008', 'ap-south-1a (Rack-04)', 10737418240, 29360128, 'HEALTHY'),
    ('00000000-0000-0000-0000-000000000009', 'Node Iota',    'http://127.0.0.1:9009', 'ap-south-1b (Rack-05)', 10737418240, 29360128, 'HEALTHY')
ON CONFLICT (endpoint_url) DO UPDATE 
SET status = EXCLUDED.status, zone = EXCLUDED.zone, used_capacity = EXCLUDED.used_capacity;

-- 10. PRE-SEED INITIAL SAMPLE OBJECTS
INSERT INTO public.files (id, filename, mime_type, total_size, chunk_size, total_chunks, replication_factor, file_hash, status)
VALUES
    ('10000000-0000-0000-0000-000000000001', 'system_architecture_manifest.json', 'application/json', 15206, 4194304, 1, 9, 'b85f2c7ea3b8a230afa630e7f4eec3d1be4a68e4ce7fd96fd110a5d620fb2509', 'ACTIVE'),
    ('10000000-0000-0000-0000-000000000002', 'cloud_security_audit_report.pdf', 'application/pdf', 865484, 4194304, 1, 9, '9dd2d963f72d298147570af8b9a7201adec8031eaf4ecaf2795dc8bc7ad769ea', 'ACTIVE'),
    ('10000000-0000-0000-0000-000000000003', 'financial_ledger_2025.zip', 'application/zip', 12582912, 4194304, 3, 3, 'db815285136ca3d3c41101b58f8ff6b72d09b91a017713f9cb8aea464d9d73c4', 'ACTIVE')
ON CONFLICT (id) DO NOTHING;
