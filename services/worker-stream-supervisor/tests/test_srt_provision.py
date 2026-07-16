from worker_stream_supervisor.pool import PortPool
from worker_stream_supervisor.worker import srt_env


def test_srt_env_allocates_only_when_enabled():
    pool = PortPool(start=11000, end=11001)
    env, port = srt_env(True, pool, "s_a")
    assert port == 11000
    assert env["POD_CAPTION_TS"] == "1"
    assert env["POD_SRT_PORT"] == "11000"
    assert env["POD_SRT_HOST"] == "0.0.0.0"

    env2, port2 = srt_env(False, pool, "s_b")
    assert port2 is None
    assert env2 == {}
    assert pool.in_use_count() == 1   # disabled path allocates nothing
