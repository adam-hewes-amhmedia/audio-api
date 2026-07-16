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


def test_rejects_srt_unless_opted_in():
    # Callers that do not name srt must not silently start accepting it.
    with pytest.raises(SsrfBlocked):
        assert_url_allowed("srt://cdn.example.com:9000", resolver=_fake_resolver)


def test_allows_srt_when_scheme_opted_in():
    assert_url_allowed(
        "srt://cdn.example.com:9000",
        resolver=_fake_resolver,
        allowed_schemes=("srt",),
    )


@pytest.mark.parametrize("url", [
    "srt://10.0.0.5:9000",
    "srt://localhost:9000",
    "srt://169.254.169.254:9000",
])
def test_opting_in_srt_still_blocks_private_addresses(url):
    # The scheme opt-in must widen the scheme check only: the address guard is
    # the whole point of the function and must still fire.
    with pytest.raises(SsrfBlocked):
        assert_url_allowed(url, resolver=_fake_resolver, allowed_schemes=("srt",))


def test_allow_http_env_does_not_gate_srt(monkeypatch):
    # STREAM_ALLOW_HTTP is about plaintext HTTP, not about srt.
    monkeypatch.delenv("STREAM_ALLOW_HTTP", raising=False)
    assert_url_allowed(
        "srt://cdn.example.com:9000",
        resolver=_fake_resolver,
        allowed_schemes=("srt",),
    )


def test_opting_in_srt_does_not_admit_http(monkeypatch):
    monkeypatch.delenv("STREAM_ALLOW_HTTP", raising=False)
    with pytest.raises(SsrfBlocked):
        assert_url_allowed(
            "http://cdn.example.com/x.m3u8",
            resolver=_fake_resolver,
            allowed_schemes=("srt",),
        )
