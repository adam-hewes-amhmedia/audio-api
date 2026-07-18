BEGIN;

-- Operator-adjustable pod tuning, so a value like "streams die after 30s" can be
-- changed from the ops console without editing compose and recreating containers.
--
-- Singleton by construction. CHECK (id = 1) makes "there is exactly one settings
-- row" a database guarantee, not a convention the next person breaks. The gateway
-- upserts against id = 1 and the supervisor reads id = 1; neither has to defend
-- against a second row existing.
--
-- Column-per-setting, not (key, value). A key/value table is untyped and
-- unconstrained and invites `pod_max_duraton_s` sitting silently in a row
-- forever. Columns give real types and real CHECKs, and adding a setting becomes
-- a deliberate migration. Same reasoning as the named column lists in
-- routes/admin/sql.ts.
--
-- Every column nullable, and NULL means "use the env value". This is what makes
-- the design a pure addition: an empty table behaves exactly like today. It also
-- gives the console a real "unset" that reverts to the compose default rather
-- than guessing what the default was.
--
-- pod_max_duration_s = 0 means unlimited, matching the pod's existing "falsy
-- means no limit" (worker-stream-pod reads POD_MAX_DURATION_S and treats an empty
-- value as None). NULL is already taken by "use env", so 0 is the third state.
CREATE TABLE settings (
  id                     SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  pod_max_duration_s     INT,
  pod_idle_timeout_s     INT,
  pod_reconnect_window_s INT,
  pod_model_size         TEXT,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by             TEXT,
  CHECK (pod_max_duration_s     IS NULL OR pod_max_duration_s     >= 0),
  CHECK (pod_idle_timeout_s     IS NULL OR pod_idle_timeout_s     >  0),
  CHECK (pod_reconnect_window_s IS NULL OR pod_reconnect_window_s >= 0),
  CHECK (pod_model_size IS NULL OR pod_model_size IN ('tiny','base','small','medium','large-v3'))
);

INSERT INTO schema_migrations(version) VALUES ('0011');

COMMIT;
