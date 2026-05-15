BEGIN;

CREATE TABLE tenant_secrets (
  tenant_id      TEXT PRIMARY KEY,
  webhook_secret TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotated_at     TIMESTAMPTZ
);

INSERT INTO schema_migrations (version) VALUES ('0002');

COMMIT;
