BEGIN;

ALTER TABLE stream_pods ADD COLUMN ws_port INT;

INSERT INTO schema_migrations(version) VALUES ('0004');

COMMIT;
