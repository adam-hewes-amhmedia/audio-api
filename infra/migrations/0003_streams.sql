BEGIN;

CREATE TABLE streams (
  id                       TEXT PRIMARY KEY,
  tenant_id                TEXT NOT NULL,
  status                   TEXT NOT NULL,
  source_hint              TEXT,
  target_lang              TEXT NOT NULL DEFAULT 'en',
  options                  JSONB NOT NULL DEFAULT '{}',
  callback_url             TEXT,
  ingest_host              TEXT,
  ingest_port              INT,
  ingest_passphrase_hash   TEXT,
  pod_id                   TEXT,
  ttml_object              TEXT,
  cue_count                INT NOT NULL DEFAULT 0,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at               TIMESTAMPTZ,
  ended_at                 TIMESTAMPTZ,
  archived_at              TIMESTAMPTZ,
  error                    JSONB
);
CREATE INDEX idx_streams_tenant_created ON streams (tenant_id, created_at DESC);
CREATE INDEX idx_streams_active_status  ON streams (status)
  WHERE status IN ('provisioning','awaiting_ingest','active','ending');

CREATE TABLE stream_cues (
  stream_id   TEXT NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
  cue_id      INT  NOT NULL,
  start_ms    INT  NOT NULL,
  end_ms      INT  NOT NULL,
  text        TEXT NOT NULL,
  source_text TEXT,
  confidence  REAL,
  PRIMARY KEY (stream_id, cue_id)
);

CREATE TABLE stream_pods (
  pod_id          TEXT PRIMARY KEY,
  supervisor_host TEXT NOT NULL,
  ingest_host     TEXT NOT NULL,
  ingest_port     INT  NOT NULL,
  stream_id       TEXT REFERENCES streams(id) ON DELETE SET NULL,
  status          TEXT NOT NULL,
  last_heartbeat  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_stream_pods_heartbeat ON stream_pods (status, last_heartbeat);

INSERT INTO schema_migrations(version) VALUES ('0003');

COMMIT;
