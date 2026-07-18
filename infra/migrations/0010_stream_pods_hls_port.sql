BEGIN;

-- The pod serves a browser-playable HLS video preview on this port; the gateway
-- proxies it. Nullable: a pod may predate the column, or the HLS port pool may be
-- exhausted, in which case the stream still runs without a preview.
ALTER TABLE stream_pods ADD COLUMN hls_port INT;

INSERT INTO schema_migrations(version) VALUES ('0010');

COMMIT;
