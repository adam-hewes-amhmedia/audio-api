from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from py_common import obs


def _exporter() -> InMemorySpanExporter:
    prov = trace.get_tracer_provider()
    if not hasattr(prov, "add_span_processor"):
        prov = TracerProvider()
        trace.set_tracer_provider(prov)
    exp = InMemorySpanExporter()
    prov.add_span_processor(SimpleSpanProcessor(exp))
    return exp


def test_inference_span_records_name_and_attributes():
    exp = _exporter()
    with obs.inference_span(model_size="small", audio_ms=1200):
        pass
    spans = {s.name: s for s in exp.get_finished_spans()}
    assert "stream.inference" in spans
    attrs = spans["stream.inference"].attributes
    assert attrs["stream.model_size"] == "small"
    assert attrs["stream.audio_ms"] == 1200


def test_latency_span_duration_matches_measured_latency():
    exp = _exporter()
    obs.record_latency_span("stream.audio_to_cue", 1500, **{"stream.id": "s1"})
    span = next(s for s in exp.get_finished_spans() if s.name == "stream.audio_to_cue")
    duration_ms = (span.end_time - span.start_time) / 1_000_000
    assert abs(duration_ms - 1500) < 50         # span duration encodes the latency
    assert span.attributes["stream.id"] == "s1"


def test_latency_span_clamps_negative_to_zero():
    exp = _exporter()
    obs.record_latency_span("stream.audio_to_cue", -10)
    span = next(s for s in exp.get_finished_spans() if s.name == "stream.audio_to_cue")
    assert span.end_time >= span.start_time
