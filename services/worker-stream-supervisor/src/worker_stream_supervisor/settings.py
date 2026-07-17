"""Operator-adjustable pod settings, read at spawn time.

The gateway writes the `settings` table (singleton, id = 1); the supervisor reads
it here and turns any set column into a POD_* env override that is merged into the
pod's spawn_env. Because Forker.spawn merges {**os.environ, **spawn_env}, an
override wins over the container's environment and takes effect on the next stream
with no restart. A NULL column means "use the env value" and emits nothing.

Nothing here may ever fail a stream. A settings read that errors returns no
overrides, so the pod inherits the container env exactly as it did before the
settings table existed.
"""

import psycopg

from py_common import logging_setup

log = logging_setup.setup("worker-stream-supervisor")

_SELECT = (
    "SELECT pod_max_duration_s, pod_idle_timeout_s, pod_reconnect_window_s, "
    "pod_model_size FROM settings WHERE id = 1"
)


def settings_to_env(
    pod_max_duration_s,
    pod_idle_timeout_s,
    pod_reconnect_window_s,
    pod_model_size,
) -> dict:
    """Map a settings row to POD_* env overrides, skipping unset (NULL) columns."""
    env: dict = {}

    if pod_max_duration_s is not None:
        # 0 means unlimited. The pod treats a falsy POD_MAX_DURATION_S as no
        # limit, and "0" is truthy and would parse to 0.0 and end the stream on
        # the first frame, so unlimited serialises to "" rather than "0".
        env["POD_MAX_DURATION_S"] = "" if pod_max_duration_s == 0 else str(pod_max_duration_s)
    if pod_idle_timeout_s is not None:
        env["POD_IDLE_TIMEOUT_S"] = str(pod_idle_timeout_s)
    if pod_reconnect_window_s is not None:
        env["POD_RECONNECT_WINDOW_S"] = str(pod_reconnect_window_s)
    if pod_model_size is not None:
        env["POD_MODEL_SIZE"] = str(pod_model_size)

    return env


async def load_settings_overrides(database_url: str) -> dict:
    """Read the settings row and return POD_* overrides. Empty on any failure."""
    try:
        async with await psycopg.AsyncConnection.connect(database_url) as conn:
            async with conn.cursor() as cur:
                await cur.execute(_SELECT)
                row = await cur.fetchone()
    except Exception as e:
        # A briefly unreadable table is not a reason to refuse to start a
        # broadcast. Log loudly, fall back to the container env.
        log.warning("settings_read_failed", extra={"err": str(e)})
        return {}

    if row is None:
        return {}

    return settings_to_env(*row)
