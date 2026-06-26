"""Default-deny SSRF guard for client-supplied stream source URLs.

The stream pod is the HTTP client for whatever URL a tenant hands us, so before
ffmpeg opens a source we resolve its host and refuse any address that points at
our own infrastructure: RFC1918 / loopback / link-local / reserved / multicast
ranges and the cloud metadata service (169.254.169.254). A configurable CIDR
allow-list (STREAM_SSRF_ALLOW_CIDRS) re-permits self-hosted CDNs that live on
the same private network.
"""

from __future__ import annotations

import ipaddress
import os
import socket
from typing import Callable, Iterable, Sequence
from urllib.parse import urlsplit

# Cloud instance metadata endpoints (IMDS). Link-local already covers these, but
# call them out explicitly so the intent is unmistakable.
_METADATA_IPS = frozenset({"169.254.169.254", "fd00:ec2::254"})

Resolver = Callable[[str], Sequence[str]]


class SsrfBlocked(Exception):
    """Raised when a source URL is not allowed to be fetched."""


def _default_resolver(host: str) -> list[str]:
    infos = socket.getaddrinfo(host, None)
    # sockaddr[0] is the IP for both AF_INET and AF_INET6.
    return [info[4][0] for info in infos]


def _parse_cidrs(cidrs: Iterable[str] | None):
    nets = []
    for c in cidrs or []:
        c = c.strip()
        if c:
            nets.append(ipaddress.ip_network(c, strict=False))
    return nets


def _is_blocked_ip(ip: ipaddress._BaseAddress) -> bool:
    return (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_reserved
        or ip.is_multicast
        or ip.is_unspecified
        or str(ip) in _METADATA_IPS
    )


def assert_url_allowed(
    url: str,
    *,
    resolver: Resolver | None = None,
    allow_cidrs: Iterable[str] | None = None,
) -> None:
    """Raise SsrfBlocked unless ``url`` is safe to fetch.

    - Requires https (or http when STREAM_ALLOW_HTTP=1, POC only).
    - Resolves the host and rejects private/loopback/link-local/reserved/
      multicast/metadata addresses, unless the address falls inside a CIDR in
      ``allow_cidrs`` (defaults to the STREAM_SSRF_ALLOW_CIDRS env list).
    """
    resolver = resolver or _default_resolver
    if allow_cidrs is None:
        allow_cidrs = [c for c in os.environ.get("STREAM_SSRF_ALLOW_CIDRS", "").split(",") if c.strip()]
    allow_nets = _parse_cidrs(allow_cidrs)

    parts = urlsplit(url)
    scheme = parts.scheme.lower()
    allow_http = os.environ.get("STREAM_ALLOW_HTTP") == "1"
    if scheme == "http":
        if not allow_http:
            raise SsrfBlocked("source.url must use https://")
    elif scheme != "https":
        raise SsrfBlocked("source.url must use http(s)")

    host = parts.hostname
    if not host:
        raise SsrfBlocked("source.url has no host")

    try:
        addrs = resolver(host)
    except Exception as exc:  # DNS failure is not a reason to leak details
        raise SsrfBlocked("could not resolve source host") from exc

    if not addrs:
        raise SsrfBlocked("source host did not resolve")

    for addr in addrs:
        ip = ipaddress.ip_address(addr)
        if any(ip in net for net in allow_nets):
            continue
        if _is_blocked_ip(ip):
            # Deliberately vague: do not echo the resolved private address back.
            raise SsrfBlocked("source host resolves to a disallowed address")
