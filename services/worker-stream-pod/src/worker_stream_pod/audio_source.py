"""Real source opener: ffmpeg opens the client source (HLS / DASH / MP4 / SRT)
and decodes it to 16kHz mono s16le PCM, which we read off stdout as fixed 100ms
frames.

It SSRF-checks every source we dial out to before spawning ffmpeg, classifies
open failures (SOURCE_UNREACHABLE / SOURCE_UNSUPPORTED / STREAM_INGEST_TIMEOUT),
and ends with a reason (source_eof / source_failed / idle_timeout / max_duration)
the pod maps onto the stream lifecycle.

Secrets (header values, SRT passphrase) are passed as their own argv tokens,
never inside the URL, and are scrubbed from ffmpeg stderr before it leaves this
module: that stderr becomes a log line and a NATS stream.failed message.
"""

from __future__ import annotations

import asyncio
import re
import shutil
import time
from dataclasses import dataclass
from typing import AsyncIterator, Callable, Dict, List, Optional, Union

from py_common import logging_setup
from py_common.ssrf import assert_url_allowed, SsrfBlocked

log = logging_setup.setup("worker-stream-pod")


@dataclass(frozen=True)
class Gap:
    """A stretch of wall clock with no audio, because ingest dropped and came back.

    Yielded between frames so the cue clock, which counts frames rather than
    reading a clock, can be moved over the outage instead of drifting behind it
    for the rest of the stream.
    """
    ms: int


# What frames() yields: audio, or a hole where audio should have been.
Item = Union[bytes, Gap]

# ffmpeg echoes the input URL in most open failures, and a signed URL carries its
# credential in the query string.
_URL_QUERY_RE = re.compile(r"((?:https?|srt)://[^\s?]+)\?\S*")


class SourceError(Exception):
    def __init__(self, code: str, detail: Optional[str] = None) -> None:
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code = code
        self.detail = detail


def _is_http(url: str) -> bool:
    return url.startswith("http://") or url.startswith("https://")


class FfmpegSource:
    def __init__(
        self,
        *,
        source_kind: str,
        source_url: str,
        source_mode: Optional[str] = None,
        passphrase: Optional[str] = None,
        headers: Optional[Dict[str, str]] = None,
        frame_ms: int = 100,
        sample_rate: int = 16000,
        provision_ttl_s: float = 15.0,
        ingest_wait_s: float = 300.0,
        idle_timeout_s: float = 30.0,
        reconnect_window_s: float = 60.0,
        reconnect_backoff_s: float = 1.0,
        max_duration_s: Optional[float] = None,
        ffmpeg_bin: str = "ffmpeg",
        now: Callable[[], float] = time.monotonic,
    ) -> None:
        self.source_kind = source_kind
        self.source_url = source_url
        self.source_mode = source_mode      # srt only: "caller" or "listener"
        self.passphrase = passphrase
        self.headers = headers or {}
        self.frame_ms = frame_ms
        self.sample_rate = sample_rate
        self.frame_bytes = int(sample_rate * (frame_ms / 1000.0)) * 2  # mono s16le
        self.provision_ttl_s = provision_ttl_s
        self.ingest_wait_s = ingest_wait_s
        self.idle_timeout_s = idle_timeout_s
        self.reconnect_window_s = reconnect_window_s
        self.reconnect_backoff_s = reconnect_backoff_s
        self.max_duration_s = max_duration_s
        self.ffmpeg_bin = ffmpeg_bin
        self._now = now
        self.end_reason: Optional[str] = None
        self.reconnects = 0
        self._proc: Optional[asyncio.subprocess.Process] = None
        self._opened = False              # has any frame ever arrived
        self._gap_since: Optional[float] = None   # when the audio stopped

    def open_timeout_s(self) -> float:
        """How long to wait for the first decoded frame.

        A listener is waiting for a human to point an encoder at us, which is
        normal for minutes. Everything else is waiting on a source that should
        already be answering, where a short budget is what surfaces a dead URL.
        Once audio has flowed once, any later wait is for a reconnect instead.
        """
        if self._opened:
            return self.reconnect_window_s
        if self.source_kind == "srt" and self.source_mode == "listener":
            return self.ingest_wait_s
        return self.provision_ttl_s

    def reconnects_enabled(self) -> bool:
        """Whether EOF means "it dropped" rather than "it finished".

        Only SRT. For a manifest or a file, EOF is a legitimate end, and retrying
        would turn every normal finish into a stream that never ends.
        """
        return self.source_kind == "srt" and self.reconnect_window_s > 0

    def build_argv(self) -> List[str]:
        argv = [shutil.which(self.ffmpeg_bin) or self.ffmpeg_bin, "-nostdin", "-loglevel", "error"]
        if self.source_kind in ("hls", "dash"):
            # Start from the live edge on live manifests (tunable; see design open-Q).
            argv += ["-live_start_index", "-1"]
        if self.source_kind == "srt":
            # libsrt protocol options, which must precede -i to bind to the input.
            argv += ["-mode", self.source_mode or "caller"]
            if self.source_mode == "listener":
                # Keep ffmpeg waiting at least as long as we are, or it exits
                # first and we misreport a patient listener as a dead source.
                argv += ["-listen_timeout", str(int(self.open_timeout_s() * 1_000_000))]
            if self.passphrase:
                # Its own token, not a URL query param: ffmpeg never echoes option
                # values, but it does echo the URL when a source fails to open.
                argv += ["-passphrase", self.passphrase]
        if self.headers:
            joined = "".join(f"{k}: {v}\r\n" for k, v in self.headers.items())
            argv += ["-headers", joined]
        argv += [
            "-i", self.source_url,
            "-vn", "-ac", "1", "-ar", str(self.sample_rate),
            "-f", "s16le", "pipe:1",
        ]
        return argv

    def terminate(self) -> None:
        if self._proc and self._proc.returncode is None:
            try:
                self._proc.kill()
            except ProcessLookupError:
                pass

    def _redact(self, text: str) -> str:
        """Scrub secrets out of ffmpeg stderr before it reaches logs or NATS.

        Two sources of exposure: secrets we hold (passphrase, header values) in
        case ffmpeg ever echoes them, and the input URL, which ffmpeg does echo
        on most failures and which carries the credential for a signed source.
        """
        out = text
        for secret in (self.passphrase, *self.headers.values()):
            if secret:
                out = out.replace(secret, "***")
        return _URL_QUERY_RE.sub(r"\1?***", out)

    @staticmethod
    def _classify_open_failure(stderr: str) -> str:
        s = stderr.lower()
        if any(t in s for t in ("does not contain", "no audio", "invalid data", "could not find codec")):
            return "SOURCE_UNSUPPORTED"
        return "SOURCE_UNREACHABLE"

    def _assert_url_allowed(self) -> None:
        """Guard anything we dial out to.

        An srt listener dials nothing: it binds a local port and waits, so there
        is no address to vet. Re-run per attempt, so a redial cannot be pointed
        somewhere new by DNS changing under us.
        """
        schemes = None
        if _is_http(self.source_url):
            schemes = ("https", "http")
        elif self.source_kind == "srt" and self.source_mode == "caller":
            schemes = ("srt",)
        if schemes is None:
            return
        try:
            assert_url_allowed(self.source_url, allowed_schemes=schemes)
        except SsrfBlocked as e:
            raise SourceError("SOURCE_UNREACHABLE", str(e)) from e

    async def _spawn(self) -> None:
        self._proc = await asyncio.create_subprocess_exec(
            *self.build_argv(),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

    async def _reap(self) -> None:
        self.terminate()
        if self._proc is not None and self._proc.returncode is None:
            try:
                await self._proc.wait()
            except Exception:
                pass

    async def frames(self) -> AsyncIterator[Item]:
        produced = 0
        try:
            while True:
                self._assert_url_allowed()
                await self._spawn()
                assert self._proc is not None and self._proc.stdout is not None

                live = False        # has a frame arrived on *this* connection
                while True:
                    # Before any audio has ever flowed we are opening the source;
                    # after a drop we are waiting for it to come back; while it is
                    # flowing we are watching for it to go quiet.
                    timeout = self.idle_timeout_s if live else self.open_timeout_s()
                    try:
                        chunk = await asyncio.wait_for(
                            self._proc.stdout.readexactly(self.frame_bytes), timeout=timeout
                        )
                    except asyncio.IncompleteReadError as e:
                        # Clean EOF (optionally a trailing partial frame we drop).
                        if not self._opened and not e.partial:
                            await self._proc.wait()
                            stderr = (await self._proc.stderr.read()).decode("utf-8", "replace") if self._proc.stderr else ""
                            # Classify on the raw text, surface only the redacted form:
                            # detail becomes a log line and a NATS stream.failed message.
                            raise SourceError(
                                self._classify_open_failure(stderr),
                                self._redact(stderr).strip() or None,
                            )
                        break
                    except asyncio.TimeoutError:
                        self.terminate()
                        if not self._opened:
                            raise SourceError("STREAM_INGEST_TIMEOUT", "no decoded audio within provision TTL")
                        if not live:
                            # The reconnect window closed with nobody back.
                            self.end_reason = "source_eof"
                            return
                        self.end_reason = "idle_timeout"
                        return

                    if self._gap_since is not None:
                        # Audio is back. Report how long it was away so the cue
                        # clock, which counts frames, can be moved over the hole
                        # rather than running the rest of the stream that far behind.
                        gap_ms = int((self._now() - self._gap_since) * 1000)
                        self._gap_since = None
                        self.reconnects += 1
                        log.info("source_reconnected", extra={
                            "source_kind": self.source_kind, "source_mode": self.source_mode,
                            "gap_ms": gap_ms, "reconnects": self.reconnects,
                        })
                        yield Gap(gap_ms)

                    live = True
                    self._opened = True
                    produced += 1
                    yield chunk

                    if self.max_duration_s is not None and (produced * self.frame_ms) >= self.max_duration_s * 1000:
                        self.terminate()
                        self.end_reason = "max_duration"
                        return

                # EOF. Either the source finished, or ingest dropped and may return.
                rc = await self._proc.wait()
                if not self.reconnects_enabled():
                    self.end_reason = "source_eof" if rc == 0 else "source_failed"
                    return

                if self._gap_since is None:
                    self._gap_since = self._now()
                    log.info("source_dropped", extra={
                        "source_kind": self.source_kind, "source_mode": self.source_mode,
                        "window_s": self.reconnect_window_s,
                    })
                if (self._now() - self._gap_since) >= self.reconnect_window_s:
                    self.end_reason = "source_eof"
                    return

                await self._reap()
                # A caller whose target is down exits immediately, so without this
                # the redial would spin flat out for the whole window.
                if self.reconnect_backoff_s:
                    await asyncio.sleep(self.reconnect_backoff_s)
        finally:
            # Reap inside the running loop so the subprocess transport is closed
            # before the loop tears down (avoids Windows proactor ResourceWarnings).
            await self._reap()
