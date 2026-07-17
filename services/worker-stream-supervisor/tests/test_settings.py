import asyncio

from worker_stream_supervisor.settings import load_settings_overrides, settings_to_env

# A closed port: connection refused is instant and exercises the fallback path
# without needing a database.
_NO_DB = "postgres://x:x@127.0.0.1:1/x"


def test_maps_every_set_column_to_its_pod_env_var():
    env = settings_to_env(
        pod_max_duration_s=300,
        pod_idle_timeout_s=45,
        pod_reconnect_window_s=90,
        pod_model_size="medium",
    )
    assert env == {
        "POD_MAX_DURATION_S": "300",
        "POD_IDLE_TIMEOUT_S": "45",
        "POD_RECONNECT_WINDOW_S": "90",
        "POD_MODEL_SIZE": "medium",
    }


def test_null_columns_emit_no_override():
    # NULL means "use the env value", so an unset column must not appear at all —
    # emitting it as "" or "None" would override the container default with junk.
    assert settings_to_env(None, None, None, None) == {}
    assert settings_to_env(
        pod_max_duration_s=120,
        pod_idle_timeout_s=None,
        pod_reconnect_window_s=None,
        pod_model_size=None,
    ) == {"POD_MAX_DURATION_S": "120"}


def test_zero_max_duration_serialises_to_empty_string():
    # The pod reads POD_MAX_DURATION_S and treats a falsy value as unlimited. "0"
    # is a truthy string and parses to 0.0, which ends the stream on the first
    # frame. 0 (unlimited) must therefore serialise to "", not "0".
    assert settings_to_env(0, None, None, None) == {"POD_MAX_DURATION_S": ""}


def test_db_failure_falls_back_to_env():
    # The highest-value test here: a briefly unreadable settings table must never
    # fail a stream. No overrides means the pod inherits the container env exactly
    # as it did before settings existed.
    assert asyncio.run(load_settings_overrides(_NO_DB)) == {}
