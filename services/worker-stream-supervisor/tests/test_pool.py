import pytest
from worker_stream_supervisor.pool import PortPool, PoolFull


def test_port_pool_allocates_unique_ports():
    p = PortPool(start=9000, end=9002)
    a, b, c = p.allocate("s1"), p.allocate("s2"), p.allocate("s3")
    assert {a, b, c} == {9000, 9001, 9002}


def test_port_pool_raises_when_full():
    p = PortPool(start=9000, end=9001)
    p.allocate("s1")
    p.allocate("s2")
    with pytest.raises(PoolFull):
        p.allocate("s3")


def test_port_pool_releases_on_free():
    p = PortPool(start=9000, end=9000)
    p.allocate("s1")
    p.free("s1")
    assert p.allocate("s2") == 9000


def test_port_pool_returns_existing_for_known_stream():
    p = PortPool(start=9000, end=9002)
    first = p.allocate("s1")
    again = p.allocate("s1")
    assert first == again
    assert p.in_use_count() == 1
