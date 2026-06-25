BEGIN;

-- Plan 5 pivot: live-subtitles ingest switches from SRT push to URL pull
-- (HLS/DASH/MP4). The gateway now accepts a source descriptor; the pod pulls
-- the URL (stubbed in Plan 5, real ffmpeg in Plan 6). Inbound SRT ingest
-- host/port are gone; the only network surface is the WS fan-out port.

-- streams: replace SRT ingest columns with a source descriptor ---------------
ALTER TABLE streams ADD COLUMN source_kind    TEXT;
ALTER TABLE streams ADD COLUMN source_url     TEXT;
ALTER TABLE streams ADD COLUMN source_headers JSONB;   -- Plan 5: plaintext (pod is stubbed, never fetches). Plan 6 migrates to encrypted bytea before any real pull.

-- Backfill any pre-existing rows so the NOT NULL/CHECK constraints can land.
UPDATE streams SET source_kind = 'hls' WHERE source_kind IS NULL;
UPDATE streams SET source_url  = ''    WHERE source_url  IS NULL;

ALTER TABLE streams ALTER COLUMN source_kind SET NOT NULL;
ALTER TABLE streams ALTER COLUMN source_url  SET NOT NULL;
ALTER TABLE streams ADD CONSTRAINT streams_source_kind_chk CHECK (source_kind IN ('hls','dash','mp4'));

ALTER TABLE streams DROP COLUMN ingest_host;
ALTER TABLE streams DROP COLUMN ingest_port;
ALTER TABLE streams DROP COLUMN ingest_passphrase_hash;

-- stream_pods: the only managed port is the WS fan-out port ------------------
ALTER TABLE stream_pods ADD COLUMN ws_host TEXT;
UPDATE stream_pods SET ws_host = ingest_host WHERE ws_host IS NULL;
UPDATE stream_pods SET ws_host = supervisor_host WHERE ws_host IS NULL;
ALTER TABLE stream_pods ALTER COLUMN ws_host SET NOT NULL;

ALTER TABLE stream_pods DROP COLUMN ingest_host;
ALTER TABLE stream_pods DROP COLUMN ingest_port;

INSERT INTO schema_migrations(version) VALUES ('0005');

COMMIT;
