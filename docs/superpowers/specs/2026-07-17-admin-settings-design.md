# Admin settings: operator-adjustable stream tuning

## Problem

`POD_MAX_DURATION_S: "30"` is hardcoded in `infra/docker-compose.yml`. Every live stream dies after 30 seconds, and the only way to change that is to edit compose and recreate containers. The same is true of every other pod tuning knob.

An operator should be able to change how long a stream may run without a deploy.

## Scope

Stream and pod tuning knobs only:

| Setting | Env var | Value today | Set where | Meaning |
|---|---|---|---|---|
| `pod_max_duration_s` | `POD_MAX_DURATION_S` | 30 | compose, supervisor block | Max stream length. `0` = unlimited. |
| `pod_idle_timeout_s` | `POD_IDLE_TIMEOUT_S` | 30 | nowhere — pod code default | Silence before the pod gives up. |
| `pod_reconnect_window_s` | `POD_RECONNECT_WINDOW_S` | 60 | nowhere — pod code default | How long a dropped source has to return. `0` disables. |
| `pod_model_size` | `POD_MODEL_SIZE` | small | compose, supervisor block | Whisper model. Pod code default is `medium`; compose overrides it. |

### Explicitly out of scope

- **Secrets and infrastructure** (`DATABASE_URL`, `STREAM_HEADERS_KEY`, `ADMIN_API_ENABLED`). `STREAM_HEADERS_KEY` seals customer credentials at rest; `ADMIN_API_ENABLED` would let the console switch off its own guard. These must never be editable from a browser.
- **Supervisor settings** (`STREAM_MAX_PODS`, port ranges). Read once at startup in `_config()`, so changing them in a database would do nothing until a restart the console cannot perform. A page that silently has no effect is worse than no page.
- **`STREAM_MAX_CONCURRENT_PER_TENANT`.** In scope conceptually, deferred deliberately: it is read by the *gateway* per request, not injected at pod spawn, so it needs a second mechanism (gateway reads the table and caches). Nothing needs it yet. It can be added to the same table later.
- **Per-tenant overrides.** Phase two. Global defaults only.

## Why this is achievable without a restart

`Forker.spawn` merges `{**os.environ, **env}`, so `spawn_env` wins over the container's environment. `handle_provision` does not currently pass `POD_MAX_DURATION_S`, which is why the pod inherits it from the supervisor's container env.

A pod is spawned per stream. So a value injected into `spawn_env` at provision time takes effect on the **next stream**, with no restart, and the pod itself needs no change at all.

This is the whole reason the design is small. It only works for settings read at pod spawn.

## Prerequisite: the gateway cannot see these settings today

`POD_MAX_DURATION_S` and `POD_MODEL_SIZE` are set in the **supervisor's** compose block. `POD_IDLE_TIMEOUT_S` and `POD_RECONNECT_WINDOW_S` are not set anywhere at all — they only exist as defaults inside the pod's `_config()`.

The admin API is served by **api-gateway**, a different container. It cannot read another service's environment. So `GET /v1/admin/settings` cannot report `default` or `source` as designed, and there is no single place that currently knows what a setting's deployment default even is.

Without fixing this, `source` would have three states (`database` / `environment` / `pod code default`) and the gateway could compute none of them. Hardcoding the defaults in the gateway would duplicate the pod's `_config()` and drift the first time someone changes one.

**Fix: move the four `POD_*` vars into `.env` / `.env.example`, with their current values.** Every service already loads `.env` via `env_file`, so:

- the gateway can read them and report `default` and `source` honestly;
- the supervisor keeps seeing them exactly as now, and so does the pod (which inherits the supervisor's environment);
- all four have an explicit env value, so `source` collapses back to two honest states: `database` or `environment`;
- the deployment default lives in one place instead of being split between compose and the pod's code.

This is a required part of the work, not a nice-to-have. `POD_MAX_DURATION_S: "30"` and `POD_MODEL_SIZE: small` move out of the supervisor block in `infra/docker-compose.yml`; `POD_IDLE_TIMEOUT_S=30` and `POD_RECONNECT_WINDOW_S=60` are written down for the first time, matching today's behaviour exactly.

## Data model

```sql
CREATE TABLE settings (
  id                      SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  pod_max_duration_s      INT,
  pod_idle_timeout_s      INT,
  pod_reconnect_window_s  INT,
  pod_model_size          TEXT,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by              TEXT
);
```

**`CHECK (id = 1)`** makes "there is exactly one settings row" a database guarantee rather than a convention someone breaks later.

**Column-per-setting, not key/value.** A `(key, value)` table is untyped and unconstrained, and invites `pod_max_duraton_s` sitting silently in a row forever. Columns give real types, real `CHECK`s, and a new setting becomes a deliberate migration. Same reasoning as the named column lists in `routes/admin/sql.ts`.

**Every column nullable. `NULL` means "use the env value".** This is what makes the design degrade safely: an empty table behaves exactly like today, so this is a pure addition. It also gives the console an "unset" action that reverts to the compose default rather than guessing what the default was.

Constraints:

```sql
CHECK (pod_max_duration_s     IS NULL OR pod_max_duration_s     >= 0)
CHECK (pod_idle_timeout_s     IS NULL OR pod_idle_timeout_s     >  0)
CHECK (pod_reconnect_window_s IS NULL OR pod_reconnect_window_s >= 0)
CHECK (pod_model_size         IS NULL OR pod_model_size IN ('tiny','base','small','medium','large-v3'))
```

### The three-state problem

The pod already treats an unset duration as unlimited:

```python
"MAX_DURATION_S": (float(os.environ["POD_MAX_DURATION_S"]) if os.environ.get("POD_MAX_DURATION_S") else None)
```

There are three states to express and `NULL` is already taken by "use env". So **`0` means unlimited**, matching the pod's existing "falsy means no limit" — `0` maps to `""` in `spawn_env`. The console renders this as an explicit "No limit" option rather than a magic zero, and requires confirmation: an unlimited live stream holds a GPU until something else kills it.

## Admin API

### `GET /v1/admin/settings`

Returns all four facts per setting. This is the mitigation for the dual-source cost of this design — without `effective` and `source`, compose saying 30 while the console says 300 is a debugging trap.

```json
{
  "pod_max_duration_s": { "value": 300,  "default": 30, "effective": 300, "source": "database" },
  "pod_idle_timeout_s": { "value": null, "default": 30, "effective": 30,  "source": "environment" }
}
```

### `PUT /v1/admin/settings`

Partial body. **Absent key** = leave alone. **Explicit `null`** = unset, revert to env. That distinction is the only reason `NULL` carries meaning in the table.

- Invalid values → `400 ADMIN_INVALID_QUERY`.
- Writes a `settings.update` audit row with before/after. These are not secrets, so values go in the payload.
- Upsert against `id = 1`.
- Last write wins. `updated_at` / `updated_by` are surfaced so a surprising value is attributable.

Both routes are covered automatically by the existing `onRoute` sweep (`admin-auth.test.ts`) and the redaction deep-scan — the payoff for building those router-driven rather than hand-listed. `openapi-admin.yaml` must document them or `admin-openapi.test.ts` fails.

## Supervisor

New module `settings.py`, one job: read the row, return env-shaped overrides.

`handle_provision` calls it before `forker.spawn` and merges the result into `spawn_env`. The pod is untouched.

**A settings read failure must never fail a stream.** Log a warning, fall back to env. A briefly unreadable settings table is not a reason to refuse to start a broadcast.

Cost: one extra DB round trip per provision. Provisioning is rare and already does several.

## Console

`/settings`. One form. Labels in operator language ("Maximum stream length", not `POD_MAX_DURATION_S`).

Each field shows its effective value, a source badge (`set here` / `from environment`), and a "Reset to default" action that sends `null`.

The page states plainly: **applies to new streams; running streams keep the settings they started with.** This is not a footnote — without it you change a value, watch a running stream ignore it, and conclude the page is broken.

## Testing

| What | Why it matters |
|---|---|
| Singleton `CHECK` rejects a second row | The guarantee the whole design leans on |
| Every `POD_*` setting resolves to the same value as today when the table is empty | Proves the `.env` move changed no behaviour |
| `GET` shape: `effective` / `source` correct for both DB-set and env-fallback | The dual-source mitigation |
| `PUT` partial update; explicit `null` unsets; absent key untouched | The core semantic |
| `PUT` validation rejects each bad value | |
| Audit row written with before/after | |
| pytest: merge function produces correct `spawn_env` overrides | |
| pytest: **DB failure falls back to env** | Where a bug means no streams start |

The supervisor tests matter most. A bug in the API is a broken page; a bug in the merge is a system that cannot start a stream.

## Risks

- **Dual source of truth.** Compose says 30, the database says 300. Accepted deliberately over making the database the only source, because an empty table on a fresh deploy would then mean "no limits at all" — "we forgot to seed" should not equal "streams run forever". `effective` + `source` on every read is the mitigation.
- **Unlimited is a real footgun.** `0` holds a GPU indefinitely. Confirmation in the UI, nothing enforced server-side, because an operator setting it deliberately is a legitimate act.
- **Only affects new streams.** Inherent to spawn-time injection, not fixable here. Must be stated in the UI.
- **Moving `POD_*` into `.env` touches a running deployment's config.** The values are carried over unchanged, and a test asserts an empty table resolves to today's values, but it is a config move and deserves the same care as any other. It also puts pod tuning in every service's environment; harmless, and already how `.env` works here.
