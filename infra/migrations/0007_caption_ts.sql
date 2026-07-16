BEGIN;

ALTER TABLE streams     ADD COLUMN caption_ts_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE stream_pods ADD COLUMN srt_port INT;

INSERT INTO schema_migrations(version) VALUES ('0007');

COMMIT;
