BEGIN;

-- The ops console needs three things the tenant-facing schema cannot give it:
-- an admin identity that is structurally incapable of being a tenant, an
-- append-only record of the destructive things an admin does, and indexes that
-- can serve a cross-tenant list.

-- Admin tokens ---------------------------------------------------------------
-- Deliberately NOT a flag on api_tokens. That table's rows all carry a
-- tenant_id and every tenant query keys off it; one stray UPDATE setting an
-- is_admin flag would turn a customer token into a cross-tenant reader. A
-- separate table with no tenant_id column makes "which tenant is this admin"
-- an unanswerable question rather than a question with a wrong answer.
-- Same hashing as api_tokens (sha256 hex, active-only unique index) so
-- admin-auth.ts can mirror auth.ts line for line.
CREATE TABLE admin_tokens (
  id              TEXT PRIMARY KEY,
  token_hash      TEXT NOT NULL,
  name            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at      TIMESTAMPTZ
);
CREATE UNIQUE INDEX idx_admin_tokens_active_hash ON admin_tokens (token_hash) WHERE revoked_at IS NULL;

-- Admin audit ----------------------------------------------------------------
-- Append-only. job_events is per-job and cascades with the job, so it covers
-- neither "an admin issued a token for a tenant" (which, with no tenants table,
-- is effectively tenant creation) nor "an admin killed a live stream".
-- No FK to admin_tokens: the audit must outlive the token that wrote it.
-- tenant_id is nullable because not every action has a tenant (e.g. a pod view).
CREATE TABLE admin_audit (
  id              BIGSERIAL PRIMARY KEY,
  ts              TIMESTAMPTZ NOT NULL DEFAULT now(),
  admin_token_id  TEXT NOT NULL,
  action          TEXT NOT NULL,
  target_type     TEXT,
  target_id       TEXT,
  tenant_id       TEXT,
  payload         JSONB
);
CREATE INDEX idx_admin_audit_ts ON admin_audit (ts DESC);

-- Cross-tenant pagination indexes --------------------------------------------
-- The existing (tenant_id, created_at DESC) indexes cannot serve an unfiltered
-- scan: without a tenant_id equality the leading column is useless for
-- ordering. Keyset paging orders by (created_at DESC, id DESC), so the index
-- has to match that exactly or every page is a seq scan + sort.
-- idx_jobs_active_status is left alone: it serves the orchestrator hot path.
CREATE INDEX idx_jobs_created_id      ON jobs    (created_at DESC, id DESC);
CREATE INDEX idx_streams_created_id   ON streams (created_at DESC, id DESC);
CREATE INDEX idx_jobs_status_created  ON jobs    (status, created_at DESC, id DESC);
CREATE INDEX idx_streams_status_created ON streams (status, created_at DESC, id DESC);

INSERT INTO schema_migrations(version) VALUES ('0009');

COMMIT;
