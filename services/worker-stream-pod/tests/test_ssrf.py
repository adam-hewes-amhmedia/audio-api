import pytest

from py_common.ssrf import assert_url_allowed, SsrfBlocked

# Map test hosts to a representative resolved IP so the guard never hits real DNS.
_HOST_IPS = {
    "169.254.169.254": ["169.254.169.254"],
    "localhost": ["127.0.0.1"],
    "10.0.0.5": ["10.0.0.5"],
    "192.168.1.10": ["192.168.1.10"],
    "::1": ["::1"],
    "cdn.example.com": ["93.184.216.34"],
    "cdn.internal": ["10.1.2.3"],
}


def _fake_resolver(host: str):
    return _HOST_IPS[host]


@pytest.mark.parametrize("url", [
    "http://169.254.169.254/latest/meta-data/",
    "https://localhost/x.m3u8",
    "https://10.0.0.5/x.m3u8",
    "https://192.168.1.10/x.m3u8",
    "https://[::1]/x.m3u8",
])
def test_blocks_private_and_metadata(url):
    with pytest.raises(SsrfBlocked):
        assert_url_allowed(url, resolver=_fake_resolver)


def test_allows_public():
    # Public IP, https: no exception.
    assert_url_allowed("https://cdn.example.com/x.m3u8", resolver=_fake_resolver)


def test_allowlist_overrides_private():
    assert_url_allowed(
        "https://cdn.internal/x.m3u8",
        resolver=_fake_resolver,
        allow_cidrs=["10.1.0.0/16"],
    )


def test_rejects_non_http_scheme():
    with pytest.raises(SsrfBlocked):
        assert_url_allowed("ftp://cdn.example.com/x", resolver=_fake_resolver)


def test_rejects_plain_http_by_default(monkeypatch):
    monkeypatch.delenv("STREAM_ALLOW_HTTP", raising=False)
    with pytest.raises(SsrfBlocked):
        assert_url_allowed("http://cdn.example.com/x.m3u8", resolver=_fake_resolver)


def test_allows_plain_http_when_opted_in(monkeypatch):
    monkeypatch.setenv("STREAM_ALLOW_HTTP", "1")
    assert_url_allowed("http://cdn.example.com/x.m3u8", resolver=_fake_resolver)
