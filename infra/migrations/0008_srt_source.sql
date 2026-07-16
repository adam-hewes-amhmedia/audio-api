BEGIN;

-- SRT sources, in both directions. This deliberately revives part of what 0005
-- removed, so read the two together:
--   * caller   -- the pod dials out to the client's SRT server. Still pure pull,
--                 exactly the shape 0005 pivoted to.
--   * listener -- the client's encoder pushes into the pod. This is the inbound
--                 media tier 0005 dropped, back by choice rather than by drift.
--
-- Not a straight revert of 0003:
--   * the port lives on stream_pods (one per pod, beside ws_port and the
--     caption srt_port), not on streams the way 0003 had it;
--   * 0003 stored ingest_passphrase_hash because it verified inbound callers
--     itself. libsrt needs the plaintext to key the connection, so this is a
--     sealed ciphertext column (the AES-256-GCM iv||tag||ct of 0006), not a
--     hash. Same reason source_headers is sealed rather than digested.

ALTER TABLE streams ADD COLUMN source_mode       TEXT;
ALTER TABLE streams ADD COLUMN source_passphrase BYTEA;

-- An srt listener has no client-supplied url: we assign the endpoint and hand
-- it back, so url cannot stay mandatory for every row.
ALTER TABLE streams ALTER COLUMN source_url DROP NOT NULL;

ALTER TABLE streams DROP CONSTRAINT streams_source_kind_chk;
ALTER TABLE streams ADD CONSTRAINT streams_source_kind_chk
  CHECK (source_kind IN ('hls','dash','mp4','srt'));

-- Separate constraints rather than one compound predicate: a violation then
-- names the rule it broke instead of pointing at a single opaque check.
ALTER TABLE streams ADD CONSTRAINT streams_source_mode_chk
  CHECK (source_mode IS NULL OR source_mode IN ('caller','listener'));

-- A mode is meaningful only for srt, and srt is meaningless without one.
ALTER TABLE streams ADD CONSTRAINT streams_srt_mode_pairing_chk
  CHECK ((source_kind = 'srt') = (source_mode IS NOT NULL));

ALTER TABLE streams ADD CONSTRAINT streams_source_url_chk
  CHECK (source_url IS NOT NULL OR (source_kind = 'srt' AND source_mode = 'listener'));

-- The inbound ingest port, allocated per stream from the supervisor's pool.
ALTER TABLE stream_pods ADD COLUMN ingest_port INT;

INSERT INTO schema_migrations(version) VALUES ('0008');

COMMIT;
