# Video Preview in the Ops Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a live video player beside the captions on the ops console stream detail page, for every source type (SRT, HLS, DASH, MP4).

**Architecture:** The pod runs an isolated preview ffmpeg (never touching the audio/captions pipeline) that produces a stream-copy HLS rendition to a local rolling dir and serves it on a new HTTP port. The gateway proxies that port under the admin scope; the Next proxy streams it through same-origin; the console plays it with Video.js.

**Tech Stack:** Python asyncio + ffmpeg (pod), Python (supervisor), Fastify + TypeScript (gateway), Next.js 16 + MUI + Video.js (console).

## Global Constraints

- **The preview must NEVER break captions.** The preview ffmpeg is a separate process; every failure is caught and logged, never raised into the stream lifecycle. Model it on `worker.py` `start_caption_egress` (best-effort subprocess, returns `(None, ...)` on any failure).
- **Admin token stays server-side.** Browser → same-origin Next proxy (`app/api/admin/[...path]/route.ts`) → gateway with the admin bearer. Never call the pod or gateway from the browser directly.
- **`hls_port` is optional, not mandatory.** Unlike `ws_port`, a missing/exhausted HLS port must not fail provisioning — the stream still starts, just without a preview.
- **Live-only, stream-copy only.** `-c:v copy`, a rolling ~12s HLS window on local disk (no object store). Non-H.264 or audio-only sources degrade to "no preview."
- **Segment routes are validated** against `^seg-\d+\.ts$` so the proxy can't fetch arbitrary pod paths.
- **Branch `feat/video-preview` in both repos** (audio-api already on it; create it in the console off `main`). Don't merge or push without Adam's say-so.
- **Migration number:** use the next free number against the current `main` (`0010` unless the admin-settings branch's `0010_settings.sql` landed first, then `0011`).
- **Gateway/pod tests** need the Docker stack up and host-facing env (docker hostnames → localhost). Gateway: `DATABASE_URL='postgres://audio:audio@localhost:5432/audio' NATS_URL='nats://localhost:4222' OBJECT_STORE_ENDPOINT='http://localhost:9000' OBJECT_STORE_BUCKET=audio-api OBJECT_STORE_ACCESS_KEY=audioadmin OBJECT_STORE_SECRET_KEY=audioadminpw OBJECT_STORE_REGION=us-east-1 pnpm test <pattern>`. Python: `pytest` from the service dir.

---

### Task 1: Migration + supervisor HLS port allocation

**Files:**
- Create: `infra/migrations/0010_stream_pods_hls_port.sql`
- Modify: `services/worker-stream-supervisor/src/worker_stream_supervisor/worker.py`
- Test: `services/worker-stream-supervisor/tests/test_hls_provision.py`

**Interfaces:**
- Produces: `stream_pods.hls_port` (nullable int); supervisor sets `POD_HLS_PORT` in `spawn_env` and writes `hls_port` when a port is allocated. Consumed by Task 3 (pod reads `POD_HLS_PORT`) and Task 4 (gateway reads `stream_pods.hls_port`).

Confirm branch:
```bash
cd /c/dev/audio-api && git branch --show-current   # expect feat/video-preview
```

- [ ] **Step 1: Write the migration**

Create `infra/migrations/0010_stream_pods_hls_port.sql` (confirm `0010` is free: `ls infra/migrations/`; if `0010_settings.sql` exists, use `0011`):

```sql
BEGIN;

-- The pod serves a browser-playable HLS video preview on this port; the gateway
-- proxies it. Nullable: a pod may predate the column, or the HLS port pool may be
-- exhausted, in which case the stream still runs without a preview.
ALTER TABLE stream_pods ADD COLUMN hls_port INT;

INSERT INTO schema_migrations(version) VALUES ('0010');

COMMIT;
```

- [ ] **Step 2: Apply the migration to the running DB**

Run: `cd /c/dev/audio-api && docker compose -f infra/docker-compose.yml run --rm migrate`
Expected: applies `0010` (no error). Verify: `docker exec audio-api-postgres-1 psql -U audio -d audio -c "\d stream_pods" | grep hls_port` shows the column.

- [ ] **Step 3: Write the failing supervisor test**

Create `services/worker-stream-supervisor/tests/test_hls_provision.py`. Mirror the harness in `test_srt_provision.py` (import `FakeForker`/`FakeJS`/`FakeMsg` patterns from there — copy the minimal fakes it uses, or import them if exported):

```python
import asyncio
import json

from worker_stream_supervisor.pool import PortPool
from worker_stream_supervisor.worker import handle_provision, handle_delete


class _EnvForker:
    """Captures spawn env; the stream_pods write after spawn fails against a bad
    DATABASE_URL, which is fine — we only assert on the env and the pools."""
    def __init__(self):
        self.env = None
    def active_count(self):
        return 0
    def spawn(self, *, stream_id, env):
        self.env = env


class _FakeMsg:
    def __init__(self, payload):
        self.data = json.dumps(payload).encode()
        self.acked = False
    async def ack(self):
        self.acked = True
    async def nak(self, delay=0):
        pass


class _FakeJS:
    def __init__(self):
        self.published = []
    async def publish(self, subject, data):
        self.published.append((subject, data))


_CFG = {"DATABASE_URL": "postgres://bad/nodb", "WS_HOST": "pod-host"}


def _provision(hls_pool):
    forker = _EnvForker()
    msg = _FakeMsg({"stream_id": "s_hls01", "tenant_id": "t", "source": {"kind": "hls", "url": "https://x/y.m3u8"}})
    ws = PortPool(start=10000, end=10009)
    srt = PortPool(start=11000, end=11009)
    ing = PortPool(start=9100, end=9109)
    # The stream_pods write will fail against the bad DB and raise, but only after
    # spawn has captured env and the ports are allocated.
    try:
        asyncio.run(handle_provision(_FakeJS(), ws, srt, ing, forker, _CFG, msg, hls_pool=hls_pool))
    except Exception:
        pass
    return forker, hls_pool


def test_hls_port_is_allocated_and_passed_as_env():
    hls = PortPool(start=10100, end=10109)
    forker, hls = _provision(hls)
    assert forker.env["POD_HLS_PORT"] == "10100"
    assert hls.in_use_count() == 1


def test_exhausted_hls_pool_still_provisions_without_a_preview():
    hls = PortPool(start=10100, end=10100)
    hls.allocate("s_other")  # the only HLS port is taken
    forker, hls = _provision(hls)
    # Stream still provisions (ws etc. allocated, spawn captured), just no preview.
    assert "POD_HLS_PORT" not in forker.env
    assert forker.env["STREAM_ID"] == "s_hls01"


def test_delete_frees_the_hls_port():
    hls = PortPool(start=10100, end=10109)
    hls.allocate("s_a")
    ws = PortPool(start=10000, end=10009); ws.allocate("s_a")
    srt = PortPool(start=11000, end=11009)
    ing = PortPool(start=9100, end=9109)
    msg = _FakeMsg({"stream_id": "s_a"})
    try:
        asyncio.run(handle_delete(_FakeJS(), ws, srt, ing, _EnvForker(), _CFG, msg, hls_pool=hls))
    except Exception:
        pass
    assert hls.in_use_count() == 0
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd /c/dev/audio-api/services/worker-stream-supervisor && python -m pytest tests/test_hls_provision.py -v`
Expected: FAIL — `handle_provision`/`handle_delete` don't accept `hls_pool` (TypeError).

- [ ] **Step 5: Add the HLS pool to the supervisor**

In `services/worker-stream-supervisor/src/worker_stream_supervisor/worker.py`:

Add to `_config()` (after the ingest ports, before the closing `}`):

```python
        "HLS_PORT_START": int(os.environ.get("STREAM_HLS_PORT_START", "10100")),
        "HLS_PORT_END":   int(os.environ.get("STREAM_HLS_PORT_END",   "10109")),
```

Change `handle_provision` to accept an optional keyword `hls_pool` (keyword-only with a default keeps existing call sites working) — update the signature:

```python
async def handle_provision(js, pool: PortPool, srt_pool: PortPool, ingest_pool: PortPool, forker: Forker, cfg: dict, msg, *, hls_pool: Optional[PortPool] = None) -> None:
```

After the ingest-port block (right before `pod_id = f"p_{sid[2:]}"`), allocate the HLS port best-effort (never rollback/fail on exhaustion):

```python
    # Optional: a preview port. Unlike the others, exhaustion here must not fail
    # the stream — the operator just gets no video preview.
    hls_port: Optional[int] = None
    if hls_pool is not None:
        try:
            hls_port = hls_pool.allocate(sid)
            allocated.append(hls_pool)
        except PoolFull:
            log.warning("no_free_hls_ports", extra={"stream_id": sid})
```

In `spawn_env`, add the port only when allocated (put this right after `spawn_env.update(add_env)`):

```python
    if hls_port is not None:
        spawn_env["POD_HLS_PORT"] = str(hls_port)
```

Add `hls_port` to the `stream_pods` INSERT (extend the column list, values tuple, and the `ON CONFLICT` SET):

```python
                "INSERT INTO stream_pods (pod_id, supervisor_host, ws_host, ws_port, srt_port, ingest_port, hls_port, stream_id, status) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 'starting') "
                "ON CONFLICT (pod_id) DO UPDATE SET ws_host=EXCLUDED.ws_host, ws_port=EXCLUDED.ws_port, srt_port=EXCLUDED.srt_port, ingest_port=EXCLUDED.ingest_port, hls_port=EXCLUDED.hls_port, status='starting', last_heartbeat=now()",
                (pod_id, socket.gethostname(), cfg["WS_HOST"], ws_port, srt_port, ingest_port, hls_port, sid),
```

Change `handle_delete`'s signature the same way and free the pool:

```python
async def handle_delete(js, pool: PortPool, srt_pool: PortPool, ingest_pool: PortPool, forker: Forker, cfg: dict, msg, *, hls_pool: Optional[PortPool] = None) -> None:
```

and after `ingest_pool.free(sid)`:

```python
    if hls_pool is not None:
        hls_pool.free(sid)
```

In `main()`, create the pool and pass it to both loops. After `ingest_pool = PortPool(...)`:

```python
    hls_pool = PortPool(start=cfg["HLS_PORT_START"], end=cfg["HLS_PORT_END"])
```

and in `provision_loop`/`delete_loop`, pass `hls_pool=hls_pool` to the `handle_provision`/`handle_delete` calls.

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd /c/dev/audio-api/services/worker-stream-supervisor && python -m pytest tests/test_hls_provision.py tests/test_srt_provision.py -v`
Expected: PASS — the new HLS tests pass and the existing srt-provision tests still pass (the keyword-only default keeps their call sites valid).

- [ ] **Step 7: Commit**

```bash
cd /c/dev/audio-api
git add infra/migrations/0010_stream_pods_hls_port.sql \
        services/worker-stream-supervisor/src/worker_stream_supervisor/worker.py \
        services/worker-stream-supervisor/tests/test_hls_provision.py
git commit -m "feat(supervisor): allocate an optional HLS preview port per pod

Adds stream_pods.hls_port and an HLS PortPool. Best-effort: an exhausted
pool leaves the stream running without a preview rather than failing it.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Pod — preview ffmpeg argv + SRT relay output

**Files:**
- Create: `services/worker-stream-pod/src/worker_stream_pod/video_preview.py`
- Modify: `services/worker-stream-pod/src/worker_stream_pod/audio_source.py`
- Test: `services/worker-stream-pod/tests/test_video_preview.py`
- Test: `services/worker-stream-pod/tests/test_audio_source_relay.py`

**Interfaces:**
- Produces: `build_preview_argv(*, source_kind, source_url, headers, relay_url, hls_dir, ffmpeg_bin="ffmpeg") -> list[str]` and `relay_url_for(hls_port) -> str` in `video_preview.py`; `FfmpegSource(..., relay_url: Optional[str] = None)` whose `build_argv()` appends the relay output for SRT. Consumed by Task 3.

- [ ] **Step 1: Write the failing tests**

Create `services/worker-stream-pod/tests/test_video_preview.py`:

```python
from worker_stream_pod.video_preview import build_preview_argv, relay_url_for


def test_pull_source_reads_the_source_url():
    argv = build_preview_argv(
        source_kind="hls", source_url="https://cdn/x.m3u8", headers={},
        relay_url="udp://127.0.0.1:10100", hls_dir="/tmp/hls",
    )
    assert "-i" in argv
    assert argv[argv.index("-i") + 1] == "https://cdn/x.m3u8"
    assert "udp://127.0.0.1:10100" not in argv        # pull ignores the relay
    assert "-c:v" in argv and argv[argv.index("-c:v") + 1] == "copy"
    assert "-f" in argv and "hls" in argv
    assert argv[-1] == "/tmp/hls/index.m3u8"


def test_srt_source_reads_the_relay():
    argv = build_preview_argv(
        source_kind="srt", source_url="", headers={},
        relay_url="udp://127.0.0.1:10100", hls_dir="/tmp/hls",
    )
    assert argv[argv.index("-i") + 1] == "udp://127.0.0.1:10100"


def test_video_map_is_optional_so_audio_only_only_kills_the_preview():
    argv = build_preview_argv(
        source_kind="hls", source_url="https://cdn/x.m3u8", headers={},
        relay_url="udp://127.0.0.1:10100", hls_dir="/tmp/hls",
    )
    assert "0:v:0?" in argv          # optional map: preview fails alone, captions safe


def test_relay_url_is_loopback_on_the_hls_port():
    assert relay_url_for(10100) == "udp://127.0.0.1:10100"
```

Create `services/worker-stream-pod/tests/test_audio_source_relay.py`:

```python
from worker_stream_pod.audio_source import FfmpegSource


def test_srt_source_gains_the_relay_output():
    src = FfmpegSource(source_kind="srt", source_url="srt://0.0.0.0:9100",
                       source_mode="listener", relay_url="udp://127.0.0.1:10100")
    argv = src.build_argv()
    # audio output still present...
    assert "pipe:1" in argv
    # ...plus the relay output that copies every stream (never fails on audio-only).
    assert "udp://127.0.0.1:10100" in argv
    i = argv.index("udp://127.0.0.1:10100")
    assert argv[i - 1] == "mpegts" and argv[i - 2] == "-f"
    assert "-map" in argv and "0" in argv[argv.index("-map") + 1]


def test_pull_source_argv_is_unchanged_without_a_relay():
    src = FfmpegSource(source_kind="hls", source_url="https://cdn/x.m3u8")
    argv = src.build_argv()
    assert "udp://127.0.0.1" not in " ".join(argv)   # no relay for pull sources
    assert argv[-1] == "pipe:1"
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /c/dev/audio-api/services/worker-stream-pod && python -m pytest tests/test_video_preview.py tests/test_audio_source_relay.py -v`
Expected: FAIL — `video_preview` module missing; `FfmpegSource` has no `relay_url`.

- [ ] **Step 3: Write `video_preview.py` (argv builder)**

Create `services/worker-stream-pod/src/worker_stream_pod/video_preview.py`:

```python
"""Isolated HLS video preview.

A SEPARATE ffmpeg from the audio pipeline, so the preview can never break
captions. Pull sources are opened directly; an SRT source is read from a local
UDP relay the audio ffmpeg copies its transport stream to (an SRT connection
cannot be re-opened). Video is stream-copied (-c:v copy): no re-encode, and a
source with no video track fails only this process, not captions.
"""

from __future__ import annotations

import shutil
from typing import Dict, List


def relay_url_for(hls_port: int) -> str:
    """Loopback UDP relay address. UDP on the (TCP) HLS port number: distinct
    socket namespaces, and unique per pod because hls_port is unique per pod."""
    return f"udp://127.0.0.1:{hls_port}"


def build_preview_argv(
    *,
    source_kind: str,
    source_url: str,
    headers: Dict[str, str],
    relay_url: str,
    hls_dir: str,
    ffmpeg_bin: str = "ffmpeg",
) -> List[str]:
    argv = [shutil.which(ffmpeg_bin) or ffmpeg_bin, "-nostdin", "-loglevel", "error"]
    if source_kind == "srt":
        # The audio ffmpeg relays the SRT transport stream to loopback UDP.
        argv += ["-i", relay_url]
    else:
        if headers:
            joined = "".join(f"{k}: {v}\r\n" for k, v in headers.items())
            argv += ["-headers", joined]
        argv += ["-i", source_url]
    # Optional video map: if the source has no video, only THIS process fails.
    argv += [
        "-map", "0:v:0?", "-c:v", "copy",
        "-map", "0:a:0?", "-c:a", "aac",
        "-f", "hls", "-hls_time", "2", "-hls_list_size", "6",
        "-hls_flags", "delete_segments+append_list+omit_endlist",
        f"{hls_dir}/index.m3u8",
    ]
    return argv
```

- [ ] **Step 4: Add the relay output to `FfmpegSource`**

In `services/worker-stream-pod/src/worker_stream_pod/audio_source.py`:

Add the parameter to `__init__` (after `ffmpeg_bin`):

```python
        relay_url: Optional[str] = None,
```

and store it (with the other assignments):

```python
        self.relay_url = relay_url
```

In `build_argv`, after the existing audio output block (`"-f", "s16le", "pipe:1",`), append the relay output for SRT only:

```python
        # SRT only: copy the whole transport stream to a loopback UDP relay the
        # isolated preview ffmpeg reads. -map 0 copies every stream, so it never
        # fails on an audio-only source; writing to a reader-less UDP socket never
        # blocks or fails, so the audio pipeline is unaffected if the preview dies.
        if self.relay_url and self.source_kind == "srt":
            argv += ["-map", "0", "-c", "copy", "-f", "mpegts", self.relay_url]
```

(The `argv += [... "pipe:1"]` list ends the audio output; append the relay block right after it, before `return argv`.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /c/dev/audio-api/services/worker-stream-pod && python -m pytest tests/test_video_preview.py tests/test_audio_source_relay.py -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /c/dev/audio-api
git add services/worker-stream-pod/src/worker_stream_pod/video_preview.py \
        services/worker-stream-pod/src/worker_stream_pod/audio_source.py \
        services/worker-stream-pod/tests/test_video_preview.py \
        services/worker-stream-pod/tests/test_audio_source_relay.py
git commit -m "feat(pod): preview ffmpeg argv + SRT relay output

Isolated HLS preview argv (direct for pull sources, loopback UDP relay for
SRT) and an optional relay output on the audio ffmpeg for SRT. Optional
video map means an audio-only source fails only the preview, not captions.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Pod — HLS server + preview lifecycle wiring

**Files:**
- Create: `services/worker-stream-pod/src/worker_stream_pod/hls_server.py`
- Modify: `services/worker-stream-pod/src/worker_stream_pod/worker.py`
- Test: `services/worker-stream-pod/tests/test_hls_server.py`

**Interfaces:**
- Consumes: `build_preview_argv`, `relay_url_for` (Task 2); `POD_HLS_PORT` env (Task 1).
- Produces: `serve_hls(hls_dir, host, port)` (asyncio server) and `start_video_preview(cfg, hls_dir) -> (proc, server) | (None, None)`, wired into `worker.main`.

- [ ] **Step 1: Write the failing HLS-server test**

Create `services/worker-stream-pod/tests/test_hls_server.py`:

```python
import asyncio
import urllib.request
from pathlib import Path

from worker_stream_pod.hls_server import serve_hls


def test_serves_a_file_and_rejects_traversal(tmp_path):
    (tmp_path / "index.m3u8").write_text("#EXTM3U\n")

    async def run():
        server = await serve_hls(str(tmp_path), "127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]
        try:
            ok = urllib.request.urlopen(f"http://127.0.0.1:{port}/index.m3u8", timeout=2).read()
            assert b"#EXTM3U" in ok
            # Path traversal must be refused, not served.
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{port}/../secret", timeout=2)
                bad = 200
            except urllib.error.HTTPError as e:
                bad = e.code
            assert bad in (400, 403, 404)
        finally:
            server.close()
            await server.wait_closed()

    asyncio.run(run())
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /c/dev/audio-api/services/worker-stream-pod && python -m pytest tests/test_hls_server.py -v`
Expected: FAIL — `hls_server` module missing.

- [ ] **Step 3: Write `hls_server.py`**

Create `services/worker-stream-pod/src/worker_stream_pod/hls_server.py`:

```python
"""Tiny static HTTP server for the local HLS preview dir.

Serves only index.m3u8 and seg-*.ts from one directory, with the right content
types. Refuses anything that resolves outside the dir. Runs in the pod alongside
the captions WS server; the gateway proxies it.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

_CT = {".m3u8": "application/vnd.apple.mpegurl", ".ts": "video/mp2t"}


async def serve_hls(hls_dir: str, host: str, port: int) -> asyncio.AbstractServer:
    root = Path(hls_dir).resolve()

    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        try:
            line = await asyncio.wait_for(reader.readline(), timeout=5)
            parts = line.decode("latin1").split()
            # Drain the rest of the request headers.
            while True:
                h = await asyncio.wait_for(reader.readline(), timeout=5)
                if h in (b"\r\n", b"\n", b""):
                    break
            if len(parts) < 2 or parts[0] != "GET":
                return await _respond(writer, 400, b"", "text/plain")
            name = parts[1].split("?", 1)[0].lstrip("/")
            target = (root / name).resolve()
            # Reject traversal and unknown extensions.
            if root not in target.parents or target.suffix not in _CT or not target.is_file():
                return await _respond(writer, 404, b"", "text/plain")
            await _respond(writer, 200, target.read_bytes(), _CT[target.suffix])
        except Exception:
            try:
                await _respond(writer, 500, b"", "text/plain")
            except Exception:
                pass

    async def _respond(writer, status, body, ct):
        reason = {200: "OK", 400: "Bad Request", 404: "Not Found", 500: "Internal Server Error"}.get(status, "OK")
        head = (
            f"HTTP/1.1 {status} {reason}\r\n"
            f"content-type: {ct}\r\n"
            f"content-length: {len(body)}\r\n"
            f"cache-control: no-cache\r\n"
            f"connection: close\r\n\r\n"
        ).encode("latin1")
        writer.write(head + body)
        try:
            await writer.drain()
        finally:
            writer.close()

    return await asyncio.start_server(handle, host, port)
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /c/dev/audio-api/services/worker-stream-pod && python -m pytest tests/test_hls_server.py -v`
Expected: PASS.

- [ ] **Step 5: Add `start_video_preview` and wire it into the worker**

In `services/worker-stream-pod/src/worker_stream_pod/worker.py`:

Add imports near the top:

```python
import tempfile
from worker_stream_pod.hls_server import serve_hls
from worker_stream_pod.video_preview import build_preview_argv, relay_url_for
```

Add to `_config()` (with the other env reads):

```python
        "HLS_PORT":     (int(os.environ["POD_HLS_PORT"]) if os.environ.get("POD_HLS_PORT") else None),
        "HLS_HOST":     os.environ.get("POD_HLS_HOST", "0.0.0.0"),
```

Add a best-effort starter modelled exactly on `start_caption_egress` (returns `(None, None, None)` on any failure — the preview must never fail the stream). Place it near `start_caption_egress`:

```python
async def start_video_preview(cfg):
    """Best-effort isolated HLS preview: a separate ffmpeg + a static HLS server.

    Returns (proc, server, hls_dir). On anything missing or any failure returns
    (None, None, None); the preview is optional and must never fail the stream.
    """
    if not cfg["HLS_PORT"]:
        return None, None, None
    try:
        hls_dir = tempfile.mkdtemp(prefix="hls_")
        relay = relay_url_for(cfg["HLS_PORT"])
        argv = build_preview_argv(
            source_kind=cfg["SOURCE_KIND"], source_url=cfg["SOURCE_URL"],
            headers=cfg["SOURCE_HEADERS"], relay_url=relay, hls_dir=hls_dir,
        )
        proc = await asyncio.create_subprocess_exec(*argv)
        server = await serve_hls(hls_dir, cfg["HLS_HOST"], cfg["HLS_PORT"])
        return proc, server, hls_dir
    except Exception as e:
        log.warning("video_preview_start_failed", err=str(e))
        return None, None, None
```

Pass the relay to the audio `FfmpegSource` (SRT only) — in the `audio = FfmpegSource(...)` call add:

```python
                    relay_url=(relay_url_for(cfg["HLS_PORT"]) if cfg["HLS_PORT"] else None),
```

Start the preview alongside caption egress (right after the `cap_proc, cap_sink = await start_caption_egress(cfg)` line, in the non-stub branch), and add handles next to `cap_proc = cap_task = caption_mux = None`:

```python
        prev_proc = prev_server = prev_dir = None
```
```python
                prev_proc, prev_server, prev_dir = await start_video_preview(cfg)
```

In the `finally:` block, tear it down best-effort (mirror the `cap_proc` teardown), after the caption-egress cleanup:

```python
            if prev_server is not None:
                try:
                    prev_server.close()
                    await prev_server.wait_closed()
                except Exception as e:
                    log.warning("video_preview_server_close_failed", err=str(e))
            if prev_proc is not None:
                try:
                    prev_proc.terminate()
                    try:
                        await asyncio.wait_for(prev_proc.wait(), timeout=5)
                    except asyncio.TimeoutError:
                        prev_proc.kill()
                        await prev_proc.wait()
                except Exception as e:
                    log.warning("video_preview_close_failed", err=str(e))
            if prev_dir is not None:
                try:
                    import shutil as _sh
                    _sh.rmtree(prev_dir, ignore_errors=True)
                except Exception:
                    pass
```

- [ ] **Step 6: Verify the wiring imports and the pod still starts (smoke)**

Run: `cd /c/dev/audio-api/services/worker-stream-pod && python -c "import worker_stream_pod.worker"` (imports cleanly) and `python -m pytest tests/ -q` (the pod test suite still passes; nothing regressed).
Expected: import OK, tests pass. Full ffmpeg preview is verified live in Task 6.

- [ ] **Step 7: Commit**

```bash
cd /c/dev/audio-api
git add services/worker-stream-pod/src/worker_stream_pod/hls_server.py \
        services/worker-stream-pod/src/worker_stream_pod/worker.py \
        services/worker-stream-pod/tests/test_hls_server.py
git commit -m "feat(pod): HLS preview server + isolated preview lifecycle

Serve the local HLS dir on POD_HLS_PORT and start/stop the isolated preview
ffmpeg with the same best-effort lifecycle as caption egress, so a preview
failure never touches captions.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Gateway — preview proxy routes

**Files:**
- Create: `services/api-gateway/src/routes/admin/preview.ts`
- Modify: `services/api-gateway/src/routes/admin/index.ts`
- Modify: `packages/contracts/openapi-admin.yaml`
- Test: `services/api-gateway/tests/admin-preview.test.ts`

**Interfaces:**
- Consumes: `stream_pods.hls_port` (Task 1); `audit` from `./audit.js`.
- Produces: `GET /v1/admin/streams/:id/preview/index.m3u8` and `GET /v1/admin/streams/:id/preview/:segment`, proxying the pod HLS server. Consumed by Tasks 5-6.

- [ ] **Step 1: Write the failing test**

Create `services/api-gateway/tests/admin-preview.test.ts` (fake pod HLS server via `node:http`, mirroring `streams-ws.test.ts`'s fake-upstream approach and `admin-captions-stream.test.ts`'s admin harness):

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { getPool } from "@audio-api/node-common";
import { buildAdminServer, adminHeaders, seedAdminToken, cleanFixtures, TENANT_A } from "./helpers/admin.js";

let app: Awaited<ReturnType<typeof buildAdminServer>>;
let pod: http.Server;
let podPort: number;

beforeAll(async () => {
  await cleanFixtures();
  await seedAdminToken();
  pod = http.createServer((req, res) => {
    if (req.url === "/index.m3u8") { res.setHeader("content-type", "application/vnd.apple.mpegurl"); res.end("#EXTM3U\n#EXT-X-VERSION:3\nseg-0.ts\n"); }
    else if (req.url === "/seg-0.ts") { res.setHeader("content-type", "video/mp2t"); res.end(Buffer.from([0x47, 0x40, 0x00])); }
    else { res.statusCode = 404; res.end(); }
  });
  await new Promise<void>((r) => pod.listen(0, "127.0.0.1", () => r()));
  podPort = (pod.address() as any).port;
  app = await buildAdminServer();
});

afterAll(async () => {
  try { pod.close(); } catch {}
  if (app) await app.close();
  await cleanFixtures();
});

async function seedPodStream(id: string, pid: string, hlsPort: number | null) {
  const p = getPool();
  await p.query(
    "INSERT INTO streams (id, tenant_id, status, target_lang, source_kind, source_url, pod_id) VALUES ($1,$2,'active','en','hls','https://cdn/x.m3u8',$3)",
    [id, TENANT_A, pid]
  );
  await p.query(
    "INSERT INTO stream_pods (pod_id, supervisor_host, ws_host, ws_port, hls_port, stream_id, status) VALUES ($1,'sup','127.0.0.1',9001,$2,$3,'ready')",
    [pid, hlsPort, id]
  );
}

describe("admin preview proxy", () => {
  it("proxies the playlist from the pod", async () => {
    await seedPodStream("s_adm_prev_01", "p_adm_prev_01", podPort);
    const res = await app.inject({ method: "GET", url: "/v1/admin/streams/s_adm_prev_01/preview/index.m3u8", headers: adminHeaders() });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/vnd.apple.mpegurl");
    expect(res.body).toContain("#EXTM3U");
  });

  it("proxies a segment from the pod", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/admin/streams/s_adm_prev_01/preview/seg-0.ts", headers: adminHeaders() });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("video/mp2t");
  });

  it("rejects a traversal-shaped segment name with 404", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/admin/streams/s_adm_prev_01/preview/..%2f..%2fsecret", headers: adminHeaders() });
    expect(res.statusCode).toBe(404);
  });

  it("404s ADMIN_PREVIEW_NOT_LIVE when the pod has no hls_port", async () => {
    await seedPodStream("s_adm_prev_02", "p_adm_prev_02", null);
    const res = await app.inject({ method: "GET", url: "/v1/admin/streams/s_adm_prev_02/preview/index.m3u8", headers: adminHeaders() });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("ADMIN_PREVIEW_NOT_LIVE");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run (with the gateway env prefix from Global Constraints): `... pnpm --filter api-gateway test admin-preview`
Expected: FAIL — routes 404 with the generic not-found, playlist assertions fail.

- [ ] **Step 3: Write the preview router**

Create `services/api-gateway/src/routes/admin/preview.ts`:

```ts
import { FastifyInstance, FastifyReply } from "fastify";
import { Readable } from "node:stream";
import { getPool } from "@audio-api/node-common";
import { audit } from "./audit.js";

// Browser-playable HLS video preview, proxied from the pod's HLS server. Same
// bridge shape as the captions SSE route: the browser reaches this same-origin
// via the Next proxy, and the pod is never exposed directly. Cross-tenant, and
// the playlist read is audited because it exposes customer video.
const SEGMENT_RE = /^seg-\d+\.ts$/;

async function podHls(id: string) {
  const row = await getPool().query<{ host: string; port: number; tenant_id: string }>(
    `SELECT p.ws_host AS host, p.hls_port AS port, s.tenant_id AS tenant_id
     FROM streams s JOIN stream_pods p ON p.pod_id = s.pod_id
     WHERE s.id = $1 AND p.hls_port IS NOT NULL
       AND p.status IN ('ready', 'ingesting')`,
    [id]
  );
  return row.rowCount ? row.rows[0] : null;
}

async function proxyFile(reply: FastifyReply, url: string, contentType: string) {
  let upstream: Response;
  try {
    upstream = await fetch(url, { cache: "no-store" });
  } catch {
    return reply.code(502).send({ code: "ADMIN_PREVIEW_UNREACHABLE", message: "Pod HLS server unreachable" });
  }
  if (!upstream.ok || !upstream.body) {
    return reply.code(404).send({ code: "ADMIN_PREVIEW_NOT_LIVE", message: "Preview not available yet" });
  }
  reply.header("content-type", contentType);
  reply.header("cache-control", "no-cache");
  return reply.send(Readable.fromWeb(upstream.body as any));
}

export async function adminPreviewRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>(
    "/v1/admin/streams/:id/preview/index.m3u8",
    async (req, reply) => {
      const pod = await podHls(req.params.id);
      if (!pod) return reply.code(404).send({ code: "ADMIN_PREVIEW_NOT_LIVE", message: "No live preview for this stream" });
      await audit(req, "stream.preview.view", "stream", req.params.id, pod.tenant_id);
      return proxyFile(reply, `http://${pod.host}:${pod.port}/index.m3u8`, "application/vnd.apple.mpegurl");
    }
  );

  app.get<{ Params: { id: string; segment: string } }>(
    "/v1/admin/streams/:id/preview/:segment",
    async (req, reply) => {
      // Only real segment names reach the pod; nothing that could escape its dir.
      if (!SEGMENT_RE.test(req.params.segment)) {
        return reply.code(404).send({ code: "ADMIN_NOT_FOUND", message: "Unknown segment" });
      }
      const pod = await podHls(req.params.id);
      if (!pod) return reply.code(404).send({ code: "ADMIN_PREVIEW_NOT_LIVE", message: "No live preview for this stream" });
      return proxyFile(reply, `http://${pod.host}:${pod.port}/${req.params.segment}`, "video/mp2t");
    }
  );
}
```

- [ ] **Step 4: Register the router**

In `services/api-gateway/src/routes/admin/index.ts`, import and register after the last existing `app.register(...)`:

```ts
import { adminPreviewRoutes } from "./preview.js";
```
```ts
  await app.register(adminPreviewRoutes);
```

- [ ] **Step 5: Document the routes in openapi**

In `packages/contracts/openapi-admin.yaml`, add after the `captions/stream` entry:

```yaml
  /v1/admin/streams/{id}/preview/index.m3u8:
    get:
      summary: Live video preview playlist (HLS)
      description: >
        Proxies the pod's HLS preview playlist. 404 ADMIN_PREVIEW_NOT_LIVE when
        the stream has no ready pod with an HLS port. The read is audited as
        stream.preview.view (it exposes customer video).
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
      responses:
        "200":
          description: An HLS playlist.
          content:
            application/vnd.apple.mpegurl:
              schema: { type: string }
        "401": { $ref: "#/components/responses/AuthFailed" }
        "404": { $ref: "#/components/responses/NotFound" }
  /v1/admin/streams/{id}/preview/{segment}:
    get:
      summary: Live video preview segment
      description: Proxies one HLS segment from the pod. Segment names are validated (seg-N.ts).
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
        - { name: segment, in: path, required: true, schema: { type: string } }
      responses:
        "200":
          description: An MPEG-TS segment.
          content:
            video/mp2t:
              schema: { type: string, format: binary }
        "401": { $ref: "#/components/responses/AuthFailed" }
        "404": { $ref: "#/components/responses/NotFound" }
```

- [ ] **Step 6: Run the tests + sweeps to verify they pass**

Run (with the gateway env prefix): `... pnpm --filter api-gateway test admin-preview admin-openapi admin-auth`
Expected: PASS — preview tests green; openapi documents both routes (no drift); auth sweep confirms the routes reject anonymous + tenant tokens.

- [ ] **Step 7: Commit**

```bash
cd /c/dev/audio-api
git add services/api-gateway/src/routes/admin/preview.ts \
        services/api-gateway/src/routes/admin/index.ts \
        packages/contracts/openapi-admin.yaml \
        services/api-gateway/tests/admin-preview.test.ts
git commit -m "feat(admin): HLS video preview proxy routes

GET /v1/admin/streams/:id/preview/{index.m3u8,:segment} proxy the pod's HLS
server under the admin scope, with segment-name validation and a
stream.preview.view audit. Same server-side-token bridge as captions.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Console proxy streams HLS/binary bodies

**Files:**
- Modify: `C:\dev\audio-api-console\app\api\admin\[...path]\route.ts`

**Interfaces:**
- Consumes: Task 4's routes.
- Produces: the proxy passes `application/vnd.apple.mpegurl` and `video/*` responses through as streams. Consumed by Task 6.

- [ ] **Step 1: Create the console branch**

```bash
cd /c/dev/audio-api-console
git checkout main && git pull --ff-only
git checkout -b feat/video-preview
git branch --show-current   # expect feat/video-preview
```

- [ ] **Step 2: Generalise the streaming branch**

In `app/api/admin/[...path]/route.ts`, the SSE branch currently triggers only on `text/event-stream` and hardcodes that content type. Replace it so HLS playlists and video segments also stream through with their own content type. Find:

```ts
  const contentType = upstream.headers.get("content-type") ?? "application/json";

  // SSE (the live caption feed) is a long-lived streaming response. Buffering it
  // with .text() would wait forever, so pass the body through as a stream. The
  // admin token still never leaves this server; only the cue bytes flow.
  if (contentType.startsWith("text/event-stream") && upstream.body) {
    return new NextResponse(upstream.body, {
      status: upstream.status,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "x-accel-buffering": "no",
      },
    });
  }
```

and replace with:

```ts
  const contentType = upstream.headers.get("content-type") ?? "application/json";

  // Stream, don't buffer, for responses that are long-lived (SSE) or binary
  // (HLS playlists + video segments). Buffering SSE would hang; .text() would
  // corrupt binary segments. The admin token still never leaves this server.
  const isStream =
    contentType.startsWith("text/event-stream") ||
    contentType.startsWith("application/vnd.apple.mpegurl") ||
    contentType.startsWith("video/");
  if (isStream && upstream.body) {
    return new NextResponse(upstream.body, {
      status: upstream.status,
      headers: {
        "content-type": contentType,
        "cache-control": "no-cache",
        "x-accel-buffering": "no",
      },
    });
  }
```

- [ ] **Step 3: Typecheck**

Run: `cd /c/dev/audio-api-console && pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
cd /c/dev/audio-api-console
git add "app/api/admin/[...path]/route.ts"
git commit -m "feat(proxy): stream HLS and video bodies through

Generalise the SSE passthrough to also cover application/vnd.apple.mpegurl
and video/* so the HLS preview playlist and segments are not buffered/
corrupted. Admin token stays server-side.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Console — Video.js player + layout

**Files:**
- Modify: `C:\dev\audio-api-console\package.json` (add `video.js`)
- Create: `C:\dev\audio-api-console\components\VideoPreview.tsx`
- Modify: `C:\dev\audio-api-console\app\streams\[id]\page.tsx`

**Interfaces:**
- Consumes: Tasks 4-5 (the proxied playlist URL); the `canStream` pod-readiness boolean already computed on the page.
- Produces: the finished feature.

- [ ] **Step 1: Add the dependency**

Run: `cd /c/dev/audio-api-console && pnpm add video.js && pnpm add -D @types/video.js`
Expected: `video.js` in `package.json` dependencies. (v8 bundles `@videojs/http-streaming`, so `.m3u8` plays via MSE with no separate hls.js.)

- [ ] **Step 2: Write the player component**

Create `components/VideoPreview.tsx`:

```tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { Box, Typography } from "@mui/material";
import videojs from "video.js";
import type Player from "video.js/dist/types/player";
import "video.js/dist/video-js.css";

// Plays the pod's HLS preview via the same-origin admin proxy. Gated by the
// caller on pod readiness, so this only mounts when there is a live feed. A load
// error (e.g. a non-H.264 or audio-only source that produced no playable video)
// falls back to a "no preview" message rather than a broken player.
export function VideoPreview({ streamId }: { streamId: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<Player | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!ref.current) return;
    const el = document.createElement("video-js");
    el.classList.add("vjs-default-skin");
    el.setAttribute("controls", "");
    el.setAttribute("playsinline", "");
    ref.current.appendChild(el);

    const player = videojs(el, {
      autoplay: true,
      muted: true,
      fluid: true,
      liveui: true,
      sources: [{ src: `/api/admin/streams/${streamId}/preview/index.m3u8`, type: "application/x-mpegURL" }],
    });
    player.on("error", () => setFailed(true));
    playerRef.current = player;

    return () => {
      try { player.dispose(); } catch {}
      playerRef.current = null;
    };
  }, [streamId]);

  return (
    <Box>
      <Box ref={ref} sx={{ display: failed ? "none" : "block" }} />
      {failed && (
        <Typography color="text.secondary" variant="body2" sx={{ p: 2 }}>
          No video preview for this stream (the source may be audio-only or a codec the browser can&apos;t play).
        </Typography>
      )}
    </Box>
  );
}
```

- [ ] **Step 3: Restructure the detail page layout and mount the player**

In `app/streams/[id]/page.tsx`:

Add the import:

```tsx
import { VideoPreview } from "@/components/VideoPreview";
```

Replace the opening of the main `<Grid container spacing={2}>` block so the **top row is video (md=8) + captions (md=4)** and the Source/Pod cards move to a second row. Concretely, restructure the return so the grid reads:

- Row 1: a `<Grid size={{ xs: 12, md: 8 }}>` holding a `<Card><CardContent>` with a "Preview" title and, when `canStream`, `<VideoPreview streamId={id} />` (else a "No preview — pod not ready" `Typography`); and the existing **Captions** `<Grid size={{ xs: 12, md: 4 }}>` card beside it.
- Row 2 (a second `<Grid container>` or additional grid items): the existing **Source** and **Pod** cards (each `md={4}` or `md={6}`).

Keep the Captions card exactly as it is (finalised list + interim line). The video card mirrors the captions gate:

```tsx
        <Grid size={{ xs: 12, md: 8 }}>
          <Card>
            <CardContent>
              <Typography variant="subtitle2" sx={{ mb: 2 }}>Preview</Typography>
              {canStream ? (
                <VideoPreview streamId={id} />
              ) : (
                <Typography color="text.secondary" variant="body2">
                  No preview. Video appears once the pod is ready.
                </Typography>
              )}
            </CardContent>
          </Card>
        </Grid>
```

Move the existing Source and Pod `<Grid>` items below the video+captions row (either after closing the first `<Grid container>` and opening a second, or as later items in the same container with `md={6}` each so they sit on their own row under the md=8+md=4 top row).

- [ ] **Step 4: Typecheck and lint**

Run: `cd /c/dev/audio-api-console && pnpm typecheck && pnpm lint`
Expected: PASS. If `@types/video.js` types clash with the v8 `dist/types` import, prefer the `video.js/dist/types/player` type import shown above and remove `@types/video.js`.

- [ ] **Step 5: Commit**

```bash
cd /c/dev/audio-api-console
git add package.json pnpm-lock.yaml components/VideoPreview.tsx "app/streams/[id]/page.tsx"
git commit -m "feat(streams): Video.js preview beside the captions

Add a live HLS video player (gated on pod readiness, same as captions) in a
video-left / captions-right layout, with a graceful 'no preview' fallback
for audio-only or unplayable sources.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 6: Live end-to-end verification**

Rebuild the pod-affecting images (supervisor + pod are baked into the pod image; gateway too) and recreate, then with the console dev server running:

1. Rebuild + recreate: `cd /c/dev/audio-api && docker compose -f infra/docker-compose.yml build api-gateway worker-stream-supervisor && docker compose -f infra/docker-compose.yml up -d api-gateway worker-stream-supervisor`. (The pod image is what the supervisor forks; rebuild it too if pods run from a separate image.)
2. Start an **HLS** stream, open its detail page: the video plays beside the live captions once the pod is ready.
3. Start an **SRT** stream, confirm the preview plays (via the relay path).
4. Start an **audio-only** source: captions still work, the preview shows the "no preview" fallback, and the stream does not fail. This is the critical isolation check.

---

## Self-Review

**Spec coverage:**
- Pod isolated preview ffmpeg (direct for pull, relay for SRT) + optional video map → Task 2. HLS server + lifecycle wiring → Task 3.
- Supervisor `hls_port` pool + migration → Task 1.
- Gateway preview proxy routes + audit + segment validation + openapi → Task 4.
- Console proxy binary/HLS passthrough → Task 5. Video.js + layout + pod-readiness gate → Task 6.
- Never-break-captions guarantee → enforced in Task 2 (optional map, relay maps all streams) and Task 3 (best-effort start/stop, all failures swallowed), and verified by Task 6 step 6.4 and the Task 2 audio-only argv test.
- Live-only / stream-copy / rolling window → Task 2 argv + Task 3 tempdir. Non-goals (no object store, no overlay) → nothing in the plan adds them.

**Placeholder scan:** the migration number is the one deliberate variable (`0010` or next free), called out with the check in Task 1 Step 1 — not a placeholder, a stated dependency. No other TBDs.

**Type/name consistency:** `build_preview_argv` / `relay_url_for` signatures match between Task 2 (definition) and Task 3 (use). `FfmpegSource(relay_url=...)` matches Task 2's added param and Task 3's call. `start_video_preview` returns `(proc, server, hls_dir)` consistently. Gateway `ADMIN_PREVIEW_NOT_LIVE` / `podHls` used consistently in Task 4 and asserted in its test. `canStream` reused from the shipped captions page in Task 6. Content types (`application/vnd.apple.mpegurl`, `video/mp2t`) match across pod server (Task 3), gateway (Task 4), and proxy (Task 5).
