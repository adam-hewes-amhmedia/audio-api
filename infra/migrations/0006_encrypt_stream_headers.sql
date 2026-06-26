BEGIN;

-- Plan 6: source_headers move from plaintext JSONB (Plan 5, pod was stubbed and
-- never fetched) to AES-256-GCM ciphertext, sealed by the gateway with
-- STREAM_HEADERS_KEY before any real ffmpeg pull. The POC has no live stream
-- rows, so the column is dropped and re-added rather than migrated in place.
ALTER TABLE streams DROP COLUMN IF EXISTS source_headers;
ALTER TABLE streams ADD  COLUMN source_headers BYTEA;   -- AES-256-GCM(iv||tag||ct); key STREAM_HEADERS_KEY

INSERT INTO schema_migrations(version) VALUES ('0006');

COMMIT;
