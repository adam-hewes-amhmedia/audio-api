# Audio API Plan 3: Language + DME Classify Workers

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Prereq:** Plans 1 and 2 complete. The pipeline supports `format` and `vad`, with sync mode and webhooks.

**Goal:** Add the remaining two CPU-only analysis workers from the v1 feature set:
- `worker-language` - per-channel language detection (ISO code + confidence).
- `worker-dme-classify` - per-channel timeline classification (dialog / music / effects / mixed).

After this plan the core analysis surface is complete. Stem separation (`dme_separate`) is GPU-bound and stays for Plan 5.

**Architecture:**
- Both workers follow the established Python pattern (NATS pull subscriber, MinIO read/write, structured logs, OTel spans).
- Both dispatch in parallel after `format.ready`, alongside `vad`. Orchestrator already handles parallel dispatch via `nextStepsAfterFormatReady`; only the dispatch map needs updating.
- Aggregator extends the report shape per Section 3.4 of the spec.

**Tech Stack additions:**
- Python (language): `faster-whisper` (small model) for VAD-gated language ID, or `fasttext-langdetect` as a fallback purely text-based approach
- Python (dme): `panns_inference` (PANNs tagger) or `transformers` with the `MIT/ast-finetuned-audioset-10-10-0.4593` checkpoint

**Reference:** `docs/superpowers/specs/2026-05-14-audio-api-design.md` Sections 2.4, 3.4, 4.

---

## File Structure (changes in this plan)

```
audio-api/
  services/
    worker-language/                               NEW
      pyproject.toml
      Dockerfile
      src/worker_language/
        __init__.py
        __main__.py
        detect.py
        worker.py
      tests/test_detect.py
    worker-dme-classify/                           NEW
      pyproject.toml
      Dockerfile
      src/worker_dme_classify/
        __init__.py
        __main__.py
        classify.py
        worker.py
      tests/test_classify.py
    orchestrator/
      src/index.ts                                 MODIFIED - language+dme dispatch + event handling
      tests/pipeline.test.ts                       MODIFIED
    aggregator/
      src/aggregate.ts                             MODIFIED - language + dme_classify in report
      src/index.ts                                 MODIFIED - subscribe to new ready events
      tests/aggregate.test.ts                      MODIFIED
    api-gateway/
      src/routes/jobs.ts                           MODIFIED - accept language + dme_classify
      tests/jobs-post.test.ts                      MODIFIED
  packages/
    proto/
      schemas/events/language-ready.json           NEW
      schemas/events/dme-classify-ready.json       NEW
      src/index.ts                                 MODIFIED
    contracts/
      openapi.yaml                                 MODIFIED - analyses enum + report schema
    py-common/py_common/nats_client.py             MODIFIED - new subjects
  infra/
    docker-compose.yml                             MODIFIED - add the two workers
  tests/
    fixtures/audio/sample-mixed.wav                NEW - 5s mixed content (music + speech) for dme test
```

---

## Task 1: Event schemas and subject additions

**Files:**
- Create: `audio-api/packages/proto/schemas/events/language-ready.json`
- Create: `audio-api/packages/proto/schemas/events/dme-classify-ready.json`
- Modify: `audio-api/packages/proto/src/index.ts`
- Modify: `audio-api/packages/proto/src/index.test.ts`
- Modify: `audio-api/packages/py-common/py_common/nats_client.py`

- [ ] **Step 1: `schemas/events/language-ready.json`**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "events/language-ready.json",
  "type": "object",
  "required": ["result_object", "per_channel"],
  "properties": {
    "result_object": { "type": "string" },
    "per_channel": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["channel", "language", "confidence"],
        "properties": {
          "channel": { "type": "integer" },
          "language": { "type": "string", "pattern": "^[a-z]{2,3}(-[A-Z]{2})?$|^und$" },
          "confidence": { "type": "number", "minimum": 0, "maximum": 1 }
        }
      }
    }
  }
}
```

- [ ] **Step 2: `schemas/events/dme-classify-ready.json`**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "events/dme-classify-ready.json",
  "type": "object",
  "required": ["result_object", "per_channel"],
  "properties": {
    "result_object": { "type": "string" },
    "per_channel": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["channel", "timeline"],
        "properties": {
          "channel": { "type": "integer" },
          "timeline": {
            "type": "array",
            "items": {
              "type": "object",
              "required": ["start_ms", "end_ms", "tag"],
              "properties": {
                "start_ms": { "type": "integer" },
                "end_ms": { "type": "integer" },
                "tag": { "type": "string", "enum": ["dialog", "music", "effects", "mixed", "silence"] },
                "confidence": { "type": "number", "minimum": 0, "maximum": 1 }
              }
            }
          }
        }
      }
    }
  }
}
```

- [ ] **Step 3: Update `packages/proto/src/index.ts`**

Add validators and types:

```ts
export const validateLanguageReady = load("events/language-ready.json");
export const validateDmeClassifyReady = load("events/dme-classify-ready.json");

export interface LanguagePerChannel { channel: number; language: string; confidence: number; }
export interface LanguageReady { result_object: string; per_channel: LanguagePerChannel[]; }

export interface DmeTimelineEntry { start_ms: number; end_ms: number; tag: string; confidence?: number; }
export interface DmePerChannel { channel: number; timeline: DmeTimelineEntry[]; }
export interface DmeClassifyReady { result_object: string; per_channel: DmePerChannel[]; }
```

Update SUBJECTS:

```ts
export const SUBJECTS = {
  WORK_FETCH:               "audio.work.fetch",
  WORK_FORMAT:              "audio.work.format",
  WORK_VAD:                 "audio.work.vad",
  WORK_LANGUAGE:            "audio.work.language",
  WORK_DME_CLASSIFY:        "audio.work.dme_classify",
  EVENT_FILE_READY:         "audio.event.file.ready",
  EVENT_FORMAT_READY:       "audio.event.format.ready",
  EVENT_VAD_READY:          "audio.event.vad.ready",
  EVENT_LANGUAGE_READY:     "audio.event.language.ready",
  EVENT_DME_CLASSIFY_READY: "audio.event.dme_classify.ready",
  EVENT_JOB_DONE:           "audio.event.job.completed",
  EVENT_JOB_FAILED:         "audio.event.job.failed"
} as const;
```

- [ ] **Step 4: Test the new validators**

Append to `packages/proto/src/index.test.ts`:

```ts
import { validateLanguageReady, validateDmeClassifyReady } from "./index.js";

describe("language-ready schema", () => {
  it("accepts valid ISO codes", () => {
    expect(validateLanguageReady({
      result_object: "x",
      per_channel: [{ channel: 0, language: "en", confidence: 0.97 }]
    })).toBe(true);
    expect(validateLanguageReady({
      result_object: "x",
      per_channel: [{ channel: 0, language: "EN", confidence: 0.97 }]
    })).toBe(false);
  });
});

describe("dme-classify-ready schema", () => {
  it("validates tag enum", () => {
    expect(validateDmeClassifyReady({
      result_object: "x",
      per_channel: [{ channel: 0, timeline: [{ start_ms: 0, end_ms: 100, tag: "dialog" }] }]
    })).toBe(true);
    expect(validateDmeClassifyReady({
      result_object: "x",
      per_channel: [{ channel: 0, timeline: [{ start_ms: 0, end_ms: 100, tag: "voiceover" }] }]
    })).toBe(false);
  });
});
```

- [ ] **Step 5: Build, test**

```bash
cd audio-api/packages/proto && pnpm test && pnpm build
```
Expected: 6+ tests pass.

- [ ] **Step 6: Mirror in Python**

Edit `packages/py-common/py_common/nats_client.py` SUBJECTS dict to add:

```python
"WORK_LANGUAGE":            "audio.work.language",
"WORK_DME_CLASSIFY":        "audio.work.dme_classify",
"EVENT_LANGUAGE_READY":     "audio.event.language.ready",
"EVENT_DME_CLASSIFY_READY": "audio.event.dme_classify.ready",
```

- [ ] **Step 7: Commit**

```bash
git add audio-api/packages/proto audio-api/packages/py-common
git commit -m "feat(proto): language and dme-classify event schemas + subjects"
```

---

## Task 2: Worker-language (Whisper-small for VAD-gated language ID)

**Files:**
- Create: `audio-api/services/worker-language/pyproject.toml`
- Create: `audio-api/services/worker-language/Dockerfile`
- Create: `audio-api/services/worker-language/src/worker_language/__init__.py`
- Create: `audio-api/services/worker-language/src/worker_language/__main__.py`
- Create: `audio-api/services/worker-language/src/worker_language/detect.py`
- Create: `audio-api/services/worker-language/src/worker_language/worker.py`
- Create: `audio-api/services/worker-language/tests/test_detect.py`

- [ ] **Step 1: `pyproject.toml`**

```toml
[project]
name = "worker-language"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = [
  "py-common @ file:../../packages/py-common",
  "faster-whisper>=1.0.0",
  "soundfile>=0.12.1",
  "numpy>=1.26.0"
]
[project.optional-dependencies]
dev = ["pytest>=8.0.0"]

[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[tool.setuptools.package-dir]
"" = "src"

[tool.setuptools.packages.find]
where = ["src"]
```

- [ ] **Step 2: `src/worker_language/detect.py`**

```python
import numpy as np
import soundfile as sf
from faster_whisper import WhisperModel

_model = None
def model() -> WhisperModel:
    global _model
    if _model is None:
        _model = WhisperModel("small", device="cpu", compute_type="int8")
    return _model

def detect(path: str) -> dict:
    audio, sr = sf.read(path, always_2d=True, dtype="float32")
    per_channel = []
    duration_s = audio.shape[0] / sr
    for ch in range(audio.shape[1]):
        sig = audio[:, ch]
        # Whisper expects 16kHz mono float32
        if sr != 16000:
            import scipy.signal as sps  # type: ignore
            sig = sps.resample_poly(sig, 16000, sr).astype(np.float32)
            sr_eff = 16000
        else:
            sr_eff = sr

        # Limit to first 30s for language ID - Whisper's design point
        sig30 = sig[: 30 * sr_eff]
        lang, prob = model().detect_language(sig30)
        per_channel.append({
            "channel": ch,
            "language": lang if prob > 0.05 else "und",
            "confidence": float(round(prob, 4))
        })
    return {"per_channel": per_channel, "duration_s": duration_s}
```

- [ ] **Step 3: Test**

`tests/test_detect.py`:

```python
from pathlib import Path
import pytest
from worker_language.detect import detect

SPEECH = Path(__file__).resolve().parents[3] / "tests" / "fixtures" / "audio" / "sample-speech.wav"

@pytest.mark.skipif(not SPEECH.exists(), reason="fixture missing")
def test_detect_english_speech():
    out = detect(str(SPEECH))
    assert len(out["per_channel"]) >= 1
    ch0 = out["per_channel"][0]
    assert ch0["language"] in ("en", "und")  # tolerate model uncertainty
    assert 0.0 <= ch0["confidence"] <= 1.0
```

- [ ] **Step 4: Install and run**

```bash
cd audio-api/services/worker-language
python -m venv .venv && source .venv/bin/activate
pip install -e "../../packages/py-common[dev]"
pip install -e ".[dev]"
pytest -q
```
Expected: 1 passed (first run downloads the model ~ 250MB; subsequent runs are fast).

- [ ] **Step 5: `src/worker_language/worker.py`**

```python
import asyncio
import json
import os
import tempfile

from py_common import logging_setup, telemetry, nats_client, storage
from py_common.errors import StageError
from worker_language.detect import detect

log = logging_setup.setup("worker-language")
tracer = telemetry.setup("worker-language")

async def handle(env: dict, s3) -> dict:
    job_id = env["job_id"]
    src_key = env["payload"].get("source_object_key") or f"working/{job_id}/source.bin"
    with tempfile.NamedTemporaryFile(suffix=".bin", delete=False) as t:
        tmp = t.name
    try:
        storage.download_to_file(s3, src_key, tmp)
        try:
            result = detect(tmp)
        except Exception as e:
            raise StageError("VAD_MODEL_FAILED", str(e), retryable=True)  # reuse model-failed code
    finally:
        try: os.unlink(tmp)
        except FileNotFoundError: pass

    key = f"results/{job_id}/language.json"
    storage.upload_bytes(s3, key, json.dumps(result).encode("utf-8"))
    result["result_object"] = key
    return result

async def main():
    nc, js = await nats_client.connect()
    s3 = storage.client()
    durable = "worker-language"
    try:
        await js.add_consumer(
            "AUDIO_WORK",
            durable_name=durable,
            filter_subject=nats_client.SUBJECTS["WORK_LANGUAGE"],
            ack_policy="explicit", max_deliver=3
        )
    except Exception: pass

    sub = await js.pull_subscribe(
        subject=nats_client.SUBJECTS["WORK_LANGUAGE"], durable=durable, stream="AUDIO_WORK"
    )
    log.info("worker-language consuming")
    while True:
        try:
            msgs = await sub.fetch(batch=2, timeout=5)
        except asyncio.TimeoutError:
            continue
        for m in msgs:
            env = nats_client.decode(m.data)
            with tracer.start_as_current_span("stage.language", attributes={"job_id": env["job_id"]}):
                try:
                    out = await handle(env, s3)
                    evt = nats_client.envelope(
                        env["job_id"], env["tenant_id"], env["trace_id"], env["attempt_id"], out
                    )
                    await js.publish(nats_client.SUBJECTS["EVENT_LANGUAGE_READY"], nats_client.encode(evt))
                    await m.ack()
                    log.info("language.done", job_id=env["job_id"])
                except StageError as e:
                    if m.metadata.num_delivered >= 3:
                        fail = nats_client.envelope(env["job_id"], env["tenant_id"], env["trace_id"], env["attempt_id"],
                                                    {"stage": "language", "code": e.code, "message": str(e)})
                        await js.publish(nats_client.SUBJECTS["EVENT_JOB_FAILED"], nats_client.encode(fail))
                        await m.ack()
                    else:
                        await m.nak(delay=5)
                    log.error("language.failed", code=e.code, msg=str(e))

if __name__ == "__main__":
    asyncio.run(main())
```

- [ ] **Step 6: `__main__.py` and `__init__.py`**

`__main__.py`:

```python
from worker_language.worker import main
import asyncio
if __name__ == "__main__":
    asyncio.run(main())
```

`__init__.py`:

```python
__all__ = ["detect", "worker"]
```

- [ ] **Step 7: Dockerfile**

```dockerfile
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libsndfile1 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY packages/py-common /app/packages/py-common
COPY services/worker-language /app/services/worker-language
WORKDIR /app/services/worker-language
RUN pip install --no-cache-dir -e ../../packages/py-common
RUN pip install --no-cache-dir -e .
RUN useradd -u 1000 -m runner && chown -R runner:runner /app
USER runner
CMD ["python", "-m", "worker_language"]
```

- [ ] **Step 8: Commit**

```bash
git add audio-api/services/worker-language
git commit -m "feat(worker-language): faster-whisper per-channel language detection"
```

---

## Task 3: Worker-dme-classify (PANNs tagger)

**Files:**
- Create: `audio-api/services/worker-dme-classify/pyproject.toml`
- Create: `audio-api/services/worker-dme-classify/Dockerfile`
- Create: `audio-api/services/worker-dme-classify/src/worker_dme_classify/__init__.py`
- Create: `audio-api/services/worker-dme-classify/src/worker_dme_classify/__main__.py`
- Create: `audio-api/services/worker-dme-classify/src/worker_dme_classify/classify.py`
- Create: `audio-api/services/worker-dme-classify/src/worker_dme_classify/worker.py`
- Create: `audio-api/services/worker-dme-classify/tests/test_classify.py`
- Create: `audio-api/tests/fixtures/audio/sample-mixed.wav`

- [ ] **Step 1: Generate mixed-content fixture**

```bash
# 5s sine (music-ish) + 5s speech, concatenated, stereo
ffmpeg -y -f lavfi -i "sine=frequency=440:duration=5" -ac 2 -ar 16000 /tmp/sine.wav
ffmpeg -y -i audio-api/tests/fixtures/audio/sample-speech.wav -ac 2 -ar 16000 /tmp/speech.wav
ffmpeg -y -i "concat:/tmp/sine.wav|/tmp/speech.wav" -c copy audio-api/tests/fixtures/audio/sample-mixed.wav
```

- [ ] **Step 2: `pyproject.toml`**

```toml
[project]
name = "worker-dme-classify"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = [
  "py-common @ file:../../packages/py-common",
  "panns-inference>=0.1.1",
  "soundfile>=0.12.1",
  "numpy>=1.26.0",
  "torch>=2.2.0"
]
[project.optional-dependencies]
dev = ["pytest>=8.0.0"]

[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[tool.setuptools.package-dir]
"" = "src"

[tool.setuptools.packages.find]
where = ["src"]
```

- [ ] **Step 3: `src/worker_dme_classify/classify.py`**

PANNs labels map to AudioSet (527 classes). We project them into 4 buckets: dialog, music, effects, silence. The mapping below is the minimal viable set; tune later from real broadcast samples.

```python
import numpy as np
import soundfile as sf
from panns_inference import AudioTagging

# AudioSet label indices → bucket
SPEECH_LABELS = {0, 1, 2, 3, 4, 5, 6, 7}            # Speech, Conversation, etc.
MUSIC_LABELS  = set(range(132, 280))                # Music, Musical instrument, Singing, etc.
SILENCE_LABELS = {474}                              # Silence
# Anything else is "effects"

_tagger = None
def tagger():
    global _tagger
    if _tagger is None:
        _tagger = AudioTagging(device="cpu")
    return _tagger

SEGMENT_MS_DEFAULT = 1000  # 1s tiles

def _label_bucket(top_idx: int) -> str:
    if top_idx in SPEECH_LABELS:  return "dialog"
    if top_idx in MUSIC_LABELS:   return "music"
    if top_idx in SILENCE_LABELS: return "silence"
    return "effects"

def classify(path: str, segment_ms: int = SEGMENT_MS_DEFAULT) -> dict:
    audio, sr = sf.read(path, always_2d=True, dtype="float32")
    samples_per_segment = int(sr * segment_ms / 1000)
    per_channel = []
    duration_s = audio.shape[0] / sr
    for ch in range(audio.shape[1]):
        sig = audio[:, ch]
        timeline = []
        cur_tag = None
        cur_start = 0
        cur_conf = 0.0
        for i in range(0, len(sig), samples_per_segment):
            window = sig[i : i + samples_per_segment]
            if len(window) < int(sr * 0.5):  # skip < 0.5s tails
                break
            # PANNs expects (batch, samples) at 32kHz internally; pass float and let it resample
            clipwise, _ = tagger().inference(window[None, :])
            scores = clipwise[0]
            top = int(np.argmax(scores))
            tag = _label_bucket(top)
            conf = float(scores[top])
            start_ms = int(i / sr * 1000)
            end_ms   = int(min(i + samples_per_segment, len(sig)) / sr * 1000)
            if cur_tag is None:
                cur_tag, cur_start, cur_conf = tag, start_ms, conf
            elif tag == cur_tag:
                cur_conf = max(cur_conf, conf)
            else:
                timeline.append({"start_ms": cur_start, "end_ms": start_ms, "tag": cur_tag, "confidence": round(cur_conf, 4)})
                cur_tag, cur_start, cur_conf = tag, start_ms, conf
        if cur_tag is not None:
            timeline.append({"start_ms": cur_start, "end_ms": int(duration_s * 1000), "tag": cur_tag, "confidence": round(cur_conf, 4)})
        per_channel.append({"channel": ch, "timeline": timeline})
    return {"per_channel": per_channel, "duration_s": duration_s}
```

- [ ] **Step 4: Test**

`tests/test_classify.py`:

```python
from pathlib import Path
import pytest
from worker_dme_classify.classify import classify

MIXED = Path(__file__).resolve().parents[3] / "tests" / "fixtures" / "audio" / "sample-mixed.wav"

@pytest.mark.skipif(not MIXED.exists(), reason="fixture missing")
def test_classify_mixed():
    out = classify(str(MIXED), segment_ms=1000)
    assert "per_channel" in out
    ch0 = out["per_channel"][0]
    assert len(ch0["timeline"]) >= 1
    for seg in ch0["timeline"]:
        assert seg["tag"] in ("dialog", "music", "effects", "mixed", "silence")
        assert seg["start_ms"] < seg["end_ms"]
```

- [ ] **Step 5: Install and run**

```bash
cd audio-api/services/worker-dme-classify
python -m venv .venv && source .venv/bin/activate
pip install -e "../../packages/py-common[dev]"
pip install -e ".[dev]"
pytest -q
```
Expected: 1 passed (PANNs downloads ~80MB on first run).

- [ ] **Step 6: `worker.py`** (same template as language worker)

```python
import asyncio
import json
import os
import tempfile

from py_common import logging_setup, telemetry, nats_client, storage
from py_common.errors import StageError
from worker_dme_classify.classify import classify

log = logging_setup.setup("worker-dme-classify")
tracer = telemetry.setup("worker-dme-classify")

async def handle(env: dict, s3) -> dict:
    job_id = env["job_id"]
    src_key = env["payload"].get("source_object_key") or f"working/{job_id}/source.bin"
    seg_ms = int(env["payload"].get("segment_ms", 1000))
    with tempfile.NamedTemporaryFile(suffix=".bin", delete=False) as t:
        tmp = t.name
    try:
        storage.download_to_file(s3, src_key, tmp)
        try:
            result = classify(tmp, segment_ms=seg_ms)
        except Exception as e:
            raise StageError("DME_CLASSIFY_FAILED", str(e), retryable=True)
    finally:
        try: os.unlink(tmp)
        except FileNotFoundError: pass

    key = f"results/{job_id}/dme_classify.json"
    storage.upload_bytes(s3, key, json.dumps(result).encode("utf-8"))
    result["result_object"] = key
    return result

async def main():
    nc, js = await nats_client.connect()
    s3 = storage.client()
    durable = "worker-dme-classify"
    try:
        await js.add_consumer(
            "AUDIO_WORK",
            durable_name=durable,
            filter_subject=nats_client.SUBJECTS["WORK_DME_CLASSIFY"],
            ack_policy="explicit", max_deliver=3
        )
    except Exception: pass

    sub = await js.pull_subscribe(
        subject=nats_client.SUBJECTS["WORK_DME_CLASSIFY"], durable=durable, stream="AUDIO_WORK"
    )
    log.info("worker-dme-classify consuming")
    while True:
        try:
            msgs = await sub.fetch(batch=1, timeout=5)
        except asyncio.TimeoutError:
            continue
        for m in msgs:
            env = nats_client.decode(m.data)
            with tracer.start_as_current_span("stage.dme_classify", attributes={"job_id": env["job_id"]}):
                try:
                    out = await handle(env, s3)
                    evt = nats_client.envelope(
                        env["job_id"], env["tenant_id"], env["trace_id"], env["attempt_id"], out
                    )
                    await js.publish(nats_client.SUBJECTS["EVENT_DME_CLASSIFY_READY"], nats_client.encode(evt))
                    await m.ack()
                    log.info("dme_classify.done", job_id=env["job_id"])
                except StageError as e:
                    if m.metadata.num_delivered >= 3:
                        fail = nats_client.envelope(env["job_id"], env["tenant_id"], env["trace_id"], env["attempt_id"],
                                                    {"stage": "dme_classify", "code": e.code, "message": str(e)})
                        await js.publish(nats_client.SUBJECTS["EVENT_JOB_FAILED"], nats_client.encode(fail))
                        await m.ack()
                    else:
                        await m.nak(delay=5)
                    log.error("dme_classify.failed", code=e.code, msg=str(e))

if __name__ == "__main__":
    asyncio.run(main())
```

- [ ] **Step 7: `__main__.py` and `__init__.py`**

`__main__.py`:

```python
from worker_dme_classify.worker import main
import asyncio
if __name__ == "__main__":
    asyncio.run(main())
```

`__init__.py`:

```python
__all__ = ["classify", "worker"]
```

- [ ] **Step 8: Dockerfile**

```dockerfile
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libsndfile1 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY packages/py-common /app/packages/py-common
COPY services/worker-dme-classify /app/services/worker-dme-classify
WORKDIR /app/services/worker-dme-classify
RUN pip install --no-cache-dir -e ../../packages/py-common
RUN pip install --no-cache-dir -e .
RUN useradd -u 1000 -m runner && chown -R runner:runner /app
USER runner
CMD ["python", "-m", "worker_dme_classify"]
```

- [ ] **Step 9: Commit**

```bash
git add audio-api/services/worker-dme-classify audio-api/tests/fixtures/audio/sample-mixed.wav
git commit -m "feat(worker-dme-classify): PANNs-based per-channel D/M/E timeline"
```

---

## Task 4: Orchestrator fans out the new workers; aggregator merges them

**Files:**
- Modify: `audio-api/services/orchestrator/src/index.ts`
- Modify: `audio-api/services/orchestrator/tests/pipeline.test.ts`
- Modify: `audio-api/services/aggregator/src/aggregate.ts`
- Modify: `audio-api/services/aggregator/src/index.ts`
- Modify: `audio-api/services/aggregator/tests/aggregate.test.ts`

- [ ] **Step 1: Orchestrator subjectMap and event handling**

In `services/orchestrator/src/index.ts`, extend `subjectMap`:

```ts
const subjectMap: Record<string, string> = {
  format:        SUBJECTS.WORK_FORMAT,
  vad:           SUBJECTS.WORK_VAD,
  language:      SUBJECTS.WORK_LANGUAGE,
  dme_classify:  SUBJECTS.WORK_DME_CLASSIFY
};
```

Add `language.ready` and `dme_classify.ready` to the consumer's filter_subjects:

```ts
filter_subjects: [
  "audio.event.file.ready",
  "audio.event.format.ready",
  "audio.event.vad.ready",
  "audio.event.language.ready",
  "audio.event.dme_classify.ready",
  "audio.event.job.failed"
]
```

Add handlers (same shape as vad):

```ts
} else if (subject === SUBJECTS.EVENT_LANGUAGE_READY) {
  await getPool().query(
    "UPDATE analyses SET status='completed', completed_at=now(), result_object=$3 WHERE job_id=$1 AND name=$2",
    [env.job_id, "language", env.payload.result_object]
  );
  await getPool().query(
    "INSERT INTO job_events (job_id, kind, stage, payload) VALUES ($1,'stage_completed','language',$2)",
    [env.job_id, env.payload]
  );
} else if (subject === SUBJECTS.EVENT_DME_CLASSIFY_READY) {
  await getPool().query(
    "UPDATE analyses SET status='completed', completed_at=now(), result_object=$3 WHERE job_id=$1 AND name=$2",
    [env.job_id, "dme_classify", env.payload.result_object]
  );
  await getPool().query(
    "INSERT INTO job_events (job_id, kind, stage, payload) VALUES ($1,'stage_completed','dme_classify',$2)",
    [env.job_id, env.payload]
  );
}
```

- [ ] **Step 2: Update orchestrator pipeline test**

Append to `tests/pipeline.test.ts`:

```ts
it("fans out language and dme_classify after format", () => {
  const next = nextStepsAfterFormatReady({ analyses: ["format", "language", "dme_classify"] });
  expect(next.sort()).toEqual(["dme_classify", "language"]);
});
```

Run: `pnpm test`. Expected: PASS.

- [ ] **Step 3: Aggregator buildReport - extend for language + dme_classify**

In `services/aggregator/src/aggregate.ts`:

```ts
export function buildReport(a: BuildReportArgs) {
  const out: any = { job_id: a.job_id, input: a.input, failures: a.failures };
  if (a.perAnalysis.format) {
    const f = a.perAnalysis.format;
    out.format = {
      codec: f.codec, sample_rate: f.sample_rate, bit_depth: f.bit_depth,
      channel_count: f.channel_count, channel_layout: f.channel_layout,
      channels: Array.from({ length: f.channel_count }, (_, i) => ({ index: i, label: `ch${i}` }))
    };
  }
  if (a.perAnalysis.vad) {
    out.vad = { per_channel: a.perAnalysis.vad.per_channel };
  }
  if (a.perAnalysis.language) {
    out.language = { per_channel: a.perAnalysis.language.per_channel };
  }
  if (a.perAnalysis.dme_classify) {
    out.dme_classify = { per_channel: a.perAnalysis.dme_classify.per_channel };
  }
  return out;
}
```

- [ ] **Step 4: Aggregator test**

Append to `tests/aggregate.test.ts`:

```ts
it("includes language and dme_classify when present", () => {
  const r = buildReport({
    job_id: "j_x", input: { duration_s: 10, size_bytes: 1 },
    perAnalysis: {
      format: { codec: "pcm_s16le", sample_rate: 16000, channel_count: 2, channel_layout: "stereo", duration_s: 10 },
      language: { per_channel: [
        { channel: 0, language: "en", confidence: 0.92 },
        { channel: 1, language: "en", confidence: 0.91 }
      ]},
      dme_classify: { per_channel: [
        { channel: 0, timeline: [{ start_ms: 0, end_ms: 5000, tag: "music" }, { start_ms: 5000, end_ms: 10000, tag: "dialog" }] },
        { channel: 1, timeline: [{ start_ms: 0, end_ms: 10000, tag: "dialog" }] }
      ]}
    },
    failures: []
  });
  expect(r.language.per_channel).toHaveLength(2);
  expect(r.dme_classify.per_channel[0].timeline[0].tag).toBe("music");
});
```

Run: `pnpm test`. Expected: PASS.

- [ ] **Step 5: Aggregator subscribes to new events**

In `services/aggregator/src/index.ts`:

```ts
filter_subjects: [
  "audio.event.format.ready",
  "audio.event.vad.ready",
  "audio.event.language.ready",
  "audio.event.dme_classify.ready"
]
```

- [ ] **Step 6: Commit**

```bash
git add audio-api/services/orchestrator audio-api/services/aggregator
git commit -m "feat(pipeline): dispatch and aggregate language and dme_classify"
```

---

## Task 5: API gateway accepts the new analyses

**Files:**
- Modify: `audio-api/services/api-gateway/src/routes/jobs.ts`
- Modify: `audio-api/packages/contracts/openapi.yaml`
- Modify: `audio-api/services/api-gateway/tests/jobs-post.test.ts`

- [ ] **Step 1: Allow the new analyses**

```ts
const VALID_ANALYSES = new Set(["format", "vad", "language", "dme_classify"]);
```

- [ ] **Step 2: Update OpenAPI enum + report schema**

In `openapi.yaml`:

```yaml
items: { type: string, enum: [format, vad, language, dme_classify] }
```

Extend `JobReport` schema:

```yaml
JobReport:
  type: object
  required: [job_id]
  properties:
    job_id: { type: string }
    input:
      type: object
      properties:
        duration_s: { type: number }
        size_bytes: { type: integer }
    format: { $ref: "#/components/schemas/FormatBlock" }
    vad: { $ref: "#/components/schemas/VadBlock" }
    language: { $ref: "#/components/schemas/LanguageBlock" }
    dme_classify: { $ref: "#/components/schemas/DmeClassifyBlock" }
    failures:
      type: array
      items: { $ref: "#/components/schemas/Failure" }

FormatBlock:
  type: object
  properties:
    codec: { type: string }
    sample_rate: { type: integer }
    bit_depth: { type: integer }
    channel_count: { type: integer }
    channel_layout: { type: string }
    channels:
      type: array
      items:
        type: object
        properties:
          index: { type: integer }
          label: { type: string }

VadBlock:
  type: object
  properties:
    per_channel:
      type: array
      items:
        type: object
        properties:
          channel: { type: integer }
          speech_ratio: { type: number }
          segments:
            type: array
            items:
              type: object
              properties:
                start_ms: { type: integer }
                end_ms: { type: integer }

LanguageBlock:
  type: object
  properties:
    per_channel:
      type: array
      items:
        type: object
        properties:
          channel: { type: integer }
          language: { type: string }
          confidence: { type: number }

DmeClassifyBlock:
  type: object
  properties:
    per_channel:
      type: array
      items:
        type: object
        properties:
          channel: { type: integer }
          timeline:
            type: array
            items:
              type: object
              properties:
                start_ms: { type: integer }
                end_ms: { type: integer }
                tag: { type: string, enum: [dialog, music, effects, mixed, silence] }
                confidence: { type: number }
```

- [ ] **Step 3: Test**

Append to `tests/jobs-post.test.ts`:

```ts
it("accepts language and dme_classify", async () => {
  const app = await buildServer();
  const res = await app.inject({
    method: "POST", url: "/v1/jobs",
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: {
      input: { type: "url", url: "https://example.com/a.wav" },
      analyses: ["format", "vad", "language", "dme_classify"]
    }
  });
  expect(res.statusCode).toBe(201);
  await app.close();
});
```

Run: `pnpm test`. Expected: PASS.

- [ ] **Step 4: Spectral re-lint**

```bash
cd audio-api/packages/contracts && pnpm lint
```
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add audio-api/services/api-gateway audio-api/packages/contracts
git commit -m "feat(api-gateway): accept language and dme_classify; expand result schema"
```

---

## Task 6: Wire the new workers into docker-compose

**Files:**
- Modify: `audio-api/infra/docker-compose.yml`

- [ ] **Step 1: Add the services**

```yaml
  worker-language:
    build: { context: .., dockerfile: services/worker-language/Dockerfile }
    depends_on: [nats, minio]
    env_file: ../.env
    environment: { OTEL_SERVICE_NAME: worker-language }

  worker-dme-classify:
    build: { context: .., dockerfile: services/worker-dme-classify/Dockerfile }
    depends_on: [nats, minio]
    env_file: ../.env
    environment: { OTEL_SERVICE_NAME: worker-dme-classify }
```

- [ ] **Step 2: Build and bring up**

```bash
cd audio-api
docker compose -f infra/docker-compose.yml build worker-language worker-dme-classify
make up
docker compose -f infra/docker-compose.yml logs worker-language | tail -5
# Expected: "worker-language consuming"
docker compose -f infra/docker-compose.yml logs worker-dme-classify | tail -5
# Expected: "worker-dme-classify consuming"
```

Note: First boot pulls Whisper-small (~250MB) and PANNs CNN14 (~80MB) into the containers. Plan 7 (production deployment) will bake these into the image.

- [ ] **Step 3: Commit**

```bash
git add audio-api/infra/docker-compose.yml
git commit -m "feat(infra): compose includes worker-language and worker-dme-classify"
```

---

## Task 7: End-to-end smoke for the full analysis set

**Files:**
- Modify: `audio-api/scripts/smoke.ts`

- [ ] **Step 1: Add a full-suite smoke**

Append to `scripts/smoke.ts`:

```ts
async function smokeFullSuite() {
  console.log("\n=== Full suite: format + vad + language + dme_classify ===");
  const sub = await fetch(`${API}/v1/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      input: { type: "url", url: SAMPLE_URL },
      analyses: ["format", "vad", "language", "dme_classify"]
    })
  });
  if (sub.status !== 201) throw new Error(`submit ${sub.status}: ${await sub.text()}`);
  const { job_id } = await sub.json();
  console.log("  job_id:", job_id);

  for (let i = 0; i < 60; i++) {
    const s = await fetch(`${API}/v1/jobs/${job_id}`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    }).then(r => r.json());
    process.stdout.write(`  status=${s.status} analyses=${s.analyses.map((a: any) => `${a.name}:${a.status}`).join(",")}\r`);
    if (s.status === "completed") {
      const rep = await fetch(`${API}/v1/jobs/${job_id}/results`, {
        headers: { authorization: `Bearer ${TOKEN}` }
      }).then(r => r.json());
      console.log("\n  format:", !!rep.format, "vad:", !!rep.vad, "language:", !!rep.language, "dme:", !!rep.dme_classify);
      if (!rep.format || !rep.vad || !rep.language || !rep.dme_classify) throw new Error("missing analysis in report");
      console.log("Full suite OK");
      return;
    }
    if (s.status === "failed") throw new Error("failed: " + JSON.stringify(s));
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error("timeout");
}

smokeFullSuite().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run**

```bash
cd audio-api
TOKEN=$(./scripts/seed-token.sh | grep ^TOKEN | cut -d= -f2)
export API_TOKEN="$TOKEN"
pnpm smoke
```
Expected: format, vad, language, dme_classify all present in final report.

- [ ] **Step 3: Commit**

```bash
git add audio-api/scripts/smoke.ts
git commit -m "test(smoke): full four-analysis smoke"
```

---

## Self-Review

**Spec coverage (Plan 3):**

| Spec section | Plan 3 task |
|---|---|
| Per-channel language detection (Section 3.4) | T2 |
| D/M/E classify per-channel timeline (Section 3.4) | T3 |
| Parallel fan-out after format (Section 4.1) | T4 |
| Aggregator merges all four analyses into report (Section 3.4) | T4 |
| API accepts new analyses, OpenAPI schema updated (Section 3) | T5 |
| Containerised, OTel-traced, structured-logged | T2, T3 (workers follow established template) |
| Smoke covering the full v1 surface (Section 9.4) | T7 |

**Placeholder scan:** none.

**Type consistency:**
- `LanguagePerChannel.language` is a string matching the JSON Schema regex (`^[a-z]{2,3}(-[A-Z]{2})?$|^und$`); the Python worker returns lowercase ISO 639-1 codes via faster-whisper.
- `DmeTimelineEntry.tag` is one of `dialog | music | effects | mixed | silence` in both the JSON Schema and the Python label-bucket function. (`mixed` is reserved for a future heuristic; Plan 3 emits dialog/music/effects/silence.)
- SUBJECTS table is identical across `packages/proto` (TS) and `packages/py-common/nats_client.py` (Python).
- Orchestrator's `subjectMap` keys (`format`, `vad`, `language`, `dme_classify`) match the API's `VALID_ANALYSES` set and the `analyses.name` rows in Postgres.

**Scope:** Plan 3 ends with all four v1 analyses available via the API, dispatched in parallel, merged into one report. The full POC pipeline is now complete except for the remaining input adapters (Plan 4) and GPU separation (Plan 5).
