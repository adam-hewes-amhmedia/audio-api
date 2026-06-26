"""Stream observability helpers built on OTel spans.

The platform derives Prometheus metrics from spans via the collector's
spanmetrics connector (`traces_spanmetrics_calls_total`,
`traces_spanmetrics_latency_bucket` keyed by `span_name`). So we express the
stream KPIs as spans:

- ``inference_span`` wraps a Whisper call; its duration is the inference latency.
- ``record_latency_span`` emits a zero-work span whose *duration encodes a
  measured latency* (e.g. audio-to-cue), so the spanmetrics latency histogram
  for that span name reflects the real figure.
"""

from __future__ import annotations

import time
from contextlib import contextmanager

from opentelemetry import trace

_TRACER_NAME = "audio-api/stream"


def _tracer():
    return trace.get_tracer(_TRACER_NAME)


@contextmanager
def inference_span(*, model_size: str, audio_ms: int):
    with _tracer().start_as_current_span("stream.inference") as span:
        span.set_attribute("stream.model_size", model_size)
        span.set_attribute("stream.audio_ms", int(audio_ms))
        yield span


def record_latency_span(name: str, latency_ms: float, **attributes) -> None:
    """Emit a span named ``name`` whose duration equals ``latency_ms`` so the
    spanmetrics connector turns it into a latency histogram."""
    now = time.time_ns()
    start = now - int(max(latency_ms, 0) * 1_000_000)
    span = _tracer().start_span(name, start_time=start)
    for k, v in attributes.items():
        span.set_attribute(k, v)
    span.end(end_time=now)
