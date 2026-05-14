BEGIN;

CREATE TABLE jobs (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  status          TEXT NOT NULL,
  input_descriptor JSONB NOT NULL,
  options         JSONB NOT NULL DEFAULT '{}',
  callback_url    TEXT,
  mode            TEXT NOT NULL,
  source_object   TEXT,
  source_sha256   TEXT,
  duration_s      NUMERIC,
  size_bytes      BIGINT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  error           JSONB
);
CREATE INDEX idx_jobs_tenant_created ON jobs (tenant_id, created_at DESC);
CREATE INDEX idx_jobs_active_status  ON jobs (status) WHERE status IN ('queued','running');

CREATE TABLE analyses (
  job_id          TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  status          TEXT NOT NULL,
  attempts        INT  NOT NULL DEFAULT 0,
  result_object   TEXT,
  error           JSONB,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  PRIMARY KEY (job_id, name)
);

CREATE TABLE results (
  job_id          TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  report          JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE job_events (
  id              BIGSERIAL PRIMARY KEY,
  job_id          TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  ts              TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind            TEXT NOT NULL,
  stage           TEXT,
  payload         JSONB
);
CREATE INDEX idx_job_events_job_ts ON job_events (job_id, ts);

CREATE TABLE api_tokens (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  token_hash      TEXT NOT NULL,
  name            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at      TIMESTAMPTZ
);
CREATE UNIQUE INDEX idx_api_tokens_active_hash ON api_tokens (token_hash) WHERE revoked_at IS NULL;

CREATE TABLE schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO schema_migrations(version) VALUES ('0001');

COMMIT;
