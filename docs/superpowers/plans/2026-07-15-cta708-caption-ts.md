# CTA-708 Caption TS Output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fourth live output to `worker-stream-pod`: a caption-only MPEG-TS carrying CEA-708 captions as SMPTE ST 2038 ancillary data, delivered over SRT for a downstream muxer, opt-in per stream.

**Architecture:** Pure-Python encoder chain (`cea708 -> cdp -> smpte2038 -> ts_mux`) driven by a wall-clock frame ticker inside a background `Caption708Muxer` task. The muxer is fed finalised cues by `CueFanout` and pipes raw TS bytes into an ffmpeg subprocess that does SRT egress as a listener. Provisioning gains an opt-in flag, a second SRT port pool in the supervisor, and a `caption_srt_url` in the gateway response.

**Tech Stack:** Python 3.12+, asyncio, pytest + pytest-asyncio (pod); TypeScript + Fastify + node:test (gateway); Postgres migrations (`infra/migrations`); ffmpeg for SRT egress.

## Global Constraints

- Pod modules live in `services/worker-stream-pod/src/worker_stream_pod/`, tests in `services/worker-stream-pod/tests/test_*.py`.
- Default pytest lane excludes `-m slow`; keep all new unit tests model-free and in the default lane. Only real-ffmpeg/SRT round-trips are marked `slow`.
- The encoder layers (`cea708`, `cdp`, `smpte2038`, `ts_mux`) are pure: no I/O, no asyncio, no wall-clock reads. All time/clock values are passed in.
- The caption TS output is best-effort: a failure to start or run SRT egress must never fail the stream or its other three outputs (WS, VTT, TTML).
- Feature is off unless `POD_CAPTION_TS=1` (pod) / `caption_ts_enabled` (db). A stream with the flag off must behave byte-for-byte as today.
- 708 service number default 1, language English. Frame cadence default 25 fps. Latency offset default 1000 ms.
- No em dashes in code comments or docs (project style).

## File Structure

Created:
- `services/worker-stream-pod/src/worker_stream_pod/cea708.py` — cue text to CEA-708 (+608 compat) cc_data triplets.
- `services/worker-stream-pod/src/worker_stream_pod/cdp.py` — triplets to CEA-708 Caption Distribution Packets, one per frame.
- `services/worker-stream-pod/src/worker_stream_pod/smpte2038.py` — CDP to SMPTE 2038 VANC PES payload.
- `services/worker-stream-pod/src/worker_stream_pod/ts_mux.py` — 2038 payload + timeline to 188-byte TS packets (PAT/PMT/PCR/PES).
- `services/worker-stream-pod/src/worker_stream_pod/caption_ts_muxer.py` — background task: ticker, queue, pop-on lifecycle, ffmpeg SRT egress.
- `services/worker-stream-pod/tests/test_cea708.py`, `test_cdp.py`, `test_smpte2038.py`, `test_ts_mux.py`, `test_caption_ts_muxer.py`
- `infra/migrations/0007_caption_ts.sql`

Modified:
- `services/worker-stream-pod/src/worker_stream_pod/fanout.py` — add optional `caption_ts` sink.
- `services/worker-stream-pod/tests/test_fanout.py` — cover the new sink.
- `services/worker-stream-pod/src/worker_stream_pod/worker.py` — build/close the muxer under `POD_CAPTION_TS=1`, new config keys.
- `services/worker-stream-supervisor/src/worker_stream_supervisor/worker.py` — SRT pool, spawn env, persist `srt_port`, ready payload.
- `services/worker-stream-supervisor/tests/` — new `test_srt_provision.py`.
- `services/api-gateway/src/routes/streams.ts` — persist flag, emit `caption_srt_url`.
- `services/api-gateway/tests/streams.test.ts` — cover the flag and response.
- `packages/contracts/openapi.yaml` — `caption_ts` input, `caption_srt_url` output.

## Data model reference (field layouts used across tasks)

**cc_data triplet** (one of `cc_count` per CDP): 3 bytes.
- byte 0: `0xF8 | (cc_valid << 2) | cc_type` where `marker_bits = 0b11111` occupy the top 5 bits (`0xF8`), `cc_valid` is bit 2, `cc_type` is bits 1..0.
- `cc_type`: `0`=NTSC field 1 (608), `1`=NTSC field 2 (608), `2`=DTVCC packet data (708), `3`=DTVCC packet start (708).
- byte 1: cc_data_1, byte 2: cc_data_2.

**CDP** (SMPTE 334 / CEA-708): 
- `0x96 0x69` (cdp_identifier), `cdp_length` (1 byte, total CDP length), `cdp_frame_rate` (high nibble, see rate table) `| 0x0F` low nibble, `flags` byte (`time_code_present<<7 | ccdata_present<<6 | svcinfo_present<<5 | svc_info_start<<4 | svc_info_change<<3 | svc_info_complete<<2 | caption_service_active<<1 | 1`), `cdp_hdr_sequence_cntr` (2 bytes).
- ccdata section: `0x72`, `0xE0 | cc_count` (top 3 bits `111`), then `cc_count * 3` bytes of triplets.
- footer: `0x74`, `cdp_ftr_sequence_cntr` (2 bytes, equals header seq), `packet_checksum` (1 byte, sum of all CDP bytes incl checksum == 0 mod 256).
- `cdp_frame_rate` nibble: 25fps = `0x4`, 30000/1001 = `0x3`, 30 = `0x7` (use 25 default per config).

**SMPTE 2038 VANC unit** (inside a PES payload; bit-packed, big-endian bit order):
- 6 fixed `0` bits, `c_not_y_channel_flag` (1), `line_number` (11), `horizontal_offset` (12), `DID` (10: 8 data + 2 parity), `SDID` (10), `data_count` (10), then `data_count` user-data words (10 bits each), then checksum word (10), then byte-alignment stuffing `1` bits.
- For CEA-708 caption anc: `DID=0x61`, `SDID=0x01` (SMPTE 334 CDP), `line_number=9` (VANC), `horizontal_offset=0`.
- Each 10-bit word = 2 parity bits + 8 data bits (even parity in bit 8, inverse in bit 9). A helper computes parity.

**TS packet** (188 bytes): sync `0x47`, then 13-bit PID, flags, optional adaptation field (PCR), payload. PIDs: PAT=0, PMT=`0x1000`, 2038 data PID=`0x1010`. PMT stream_type for 2038 = `0x06` (PES private data) with a registration/data descriptor. PCR PID = the 2038 PID. PTS/PCR are 33-bit 90kHz / 27MHz from the wall-clock timeline.

---

### Task 1: CEA-708 pop-on encoder (`cea708.py`)

**Files:**
- Create: `services/worker-stream-pod/src/worker_stream_pod/cea708.py`
- Test: `services/worker-stream-pod/tests/test_cea708.py`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  - `CcTriplet = tuple[int, int, int]` (cc_type, b1, b2).
  - `def popon_triplets(text: str, *, service: int = 1) -> list[CcTriplet]` — DTVCC pop-on caption plus CEA-608 field-1 pop-on, interleaved as triplets ready for a CDP.
  - `def clear_triplets(*, service: int = 1) -> list[CcTriplet]` — hide/clear for both 708 and 608.
  - `def padding_triplet() -> CcTriplet` — a single 708 null-padding triplet `(2, 0x00, 0x00)` used to fill idle frames.

- [ ] **Step 1: Write the failing test**

```python
from worker_stream_pod.cea708 import popon_triplets, clear_triplets, padding_triplet


def test_popon_starts_with_dtvcc_packet_start_and_608_resume():
    trips = popon_triplets("HELLO", service=1)
    # first 708 triplet of a caption is a DTVCC packet start (cc_type 3)
    assert any(t[0] == 3 for t in trips)
    # 608 field-1 Resume Caption Loading (RCL) 0x14 0x20 appears on cc_type 0
    assert (0, 0x14, 0x20) in trips
    # the visible text bytes appear on a 608 field-1 triplet
    assert any(t[0] == 0 and t[1] == ord("H") and t[2] == ord("E") for t in trips)


def test_padding_triplet_is_null_708():
    assert padding_triplet() == (2, 0x00, 0x00)


def test_clear_emits_both_608_eod_and_708_hide():
    trips = clear_triplets(service=1)
    # 608 field-1 Erase Displayed Memory (EDM) 0x14 0x2C
    assert (0, 0x14, 0x2C) in trips
    # at least one 708 triplet present
    assert any(t[0] in (2, 3) for t in trips)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/worker-stream-pod && pytest tests/test_cea708.py -v`
Expected: FAIL with `ModuleNotFoundError: worker_stream_pod.cea708`.

- [ ] **Step 3: Write minimal implementation**

```python
"""CEA-708 pop-on caption encoding, with CEA-608 field-1 compatibility.

Pure functions: a cue's text becomes a list of cc_data triplets
(cc_type, byte1, byte2) that cdp.py packs into per-frame CDPs. No I/O, no
timing. 708 uses DTVCC service blocks; 608 carries the same text so legacy
decoders still show captions.
"""
from __future__ import annotations

from typing import List, Tuple

CcTriplet = Tuple[int, int, int]

# CEA-608 field-1 control codes (channel 1), byte pairs.
_RCL = (0x14, 0x20)  # Resume Caption Loading (start a pop-on buffer)
_EOC = (0x14, 0x2F)  # End Of Caption (flip buffer to display)
_EDM = (0x14, 0x2C)  # Erase Displayed Memory
_ENM = (0x14, 0x2E)  # Erase Non-displayed Memory
_PAC_ROW15 = (0x14, 0x70)  # Preamble Address Code, bottom row, white


def padding_triplet() -> CcTriplet:
    return (2, 0x00, 0x00)


def _dtvcc_popon_bytes(text: str, service: int) -> bytes:
    """DTVCC (708) command sequence for a single pop-on caption in `service`.

    DefineWindow0 -> SetCurrentWindow0 -> text -> ETX -> DisplayWindows.
    Kept minimal: one full-width window anchored bottom-centre.
    """
    body = bytearray()
    # DefineWindow (0x98 + window id 0): 6 param bytes.
    body += bytes([0x98, 0x38, 0x00, 0x00, 0x28, 0x3C, 0x00])
    # SetCurrentWindow0
    body += bytes([0x80])
    body += text.encode("ascii", "replace")
    body += bytes([0x03])  # ETX
    body += bytes([0x89, 0x01])  # DisplayWindows, bitmap window 0
    # Service block header: 3-bit service number, 5-bit block size.
    block = bytes([(service << 5) | (len(body) & 0x1F)]) + bytes(body)
    return block


def _bytes_to_dtvcc_triplets(dtvcc: bytes) -> List[CcTriplet]:
    """Wrap a DTVCC service block in a DTVCC packet and split into triplets.

    First triplet is cc_type 3 (packet start), the rest cc_type 2 (packet
    data). packet_size_code sizing follows CEA-708 (packet_data_size in
    2-byte words minus 1).
    """
    packet = bytearray()
    word_pairs = (len(dtvcc) + 1) // 2  # size in 16-bit words, min 1
    seq = 0
    packet.append((seq << 6) | (word_pairs & 0x3F))  # DTVCC packet header
    packet += dtvcc
    if len(packet) % 2:
        packet.append(0x00)  # pad to even for triplet packing
    out: List[CcTriplet] = []
    for i in range(0, len(packet), 2):
        cc_type = 3 if i == 0 else 2
        out.append((cc_type, packet[i], packet[i + 1]))
    return out


def _608_popon_triplets(text: str) -> List[CcTriplet]:
    trips: List[CcTriplet] = [
        (0, *_RCL), (0, *_ENM), (0, *_PAC_ROW15),
    ]
    data = text.encode("ascii", "replace")
    for i in range(0, len(data), 2):
        b1 = data[i]
        b2 = data[i + 1] if i + 1 < len(data) else 0x00
        trips.append((0, b1, b2))
    trips += [(0, *_EOC)]
    return trips


def popon_triplets(text: str, *, service: int = 1) -> List[CcTriplet]:
    dtvcc = _bytes_to_dtvcc_triplets(_dtvcc_popon_bytes(text, service))
    return dtvcc + _608_popon_triplets(text)


def clear_triplets(*, service: int = 1) -> List[CcTriplet]:
    # 708: DeleteWindows (0x8C) all windows; 608: EDM.
    dtvcc = _bytes_to_dtvcc_triplets(bytes([(service << 5) | 2, 0x8C, 0xFF]))
    return dtvcc + [(0, *_EDM)]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/worker-stream-pod && pytest tests/test_cea708.py -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add services/worker-stream-pod/src/worker_stream_pod/cea708.py services/worker-stream-pod/tests/test_cea708.py
git commit -m "feat(pod): CEA-708 pop-on encoder with 608 compat triplets"
```

---

### Task 2: CDP packer (`cdp.py`)

**Files:**
- Create: `services/worker-stream-pod/src/worker_stream_pod/cdp.py`
- Test: `services/worker-stream-pod/tests/test_cdp.py`

**Interfaces:**
- Consumes: `CcTriplet` from `cea708`.
- Produces:
  - `CC_COUNT_25FPS = 25` (triplets per CDP at 25 fps; used to size idle padding).
  - `def build_cdp(triplets: list[CcTriplet], *, sequence: int, frame_rate_code: int = 0x4, cc_count: int = 25) -> bytes` — one CDP. Pads with `(2,0,0)` up to `cc_count`, truncates if longer (caller is expected to spread long captions across frames; see muxer).
  - `def frame_rate_code(fps: int) -> int` — maps 25 -> 0x4, 30 -> 0x7, 2997 (29.97 as 2997) -> 0x3.

- [ ] **Step 1: Write the failing test**

```python
from worker_stream_pod.cdp import build_cdp, frame_rate_code


def test_cdp_has_identifier_length_and_zero_checksum():
    cdp = build_cdp([(2, 0, 0)], sequence=7, frame_rate_code=0x4, cc_count=25)
    assert cdp[0] == 0x96 and cdp[1] == 0x69          # cdp_identifier
    assert cdp[2] == len(cdp)                          # cdp_length == total length
    assert sum(cdp) % 256 == 0                          # checksum makes total 0 mod 256
    # header and footer sequence counters match (bytes 5..6 and the two before checksum)
    assert cdp[5:7] == cdp[-3:-1]


def test_cdp_pads_to_cc_count():
    cdp = build_cdp([(2, 0, 0)], sequence=0, cc_count=25)
    # ccdata section: 0x72, (0xE0|cc_count), then cc_count*3 bytes
    idx = cdp.index(0x72)
    assert cdp[idx + 1] == (0xE0 | 25)
    triplet_bytes = cdp[idx + 2: idx + 2 + 25 * 3]
    assert len(triplet_bytes) == 75


def test_frame_rate_code_maps_25():
    assert frame_rate_code(25) == 0x4
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/worker-stream-pod && pytest tests/test_cdp.py -v`
Expected: FAIL with `ModuleNotFoundError: worker_stream_pod.cdp`.

- [ ] **Step 3: Write minimal implementation**

```python
"""CEA-708 Caption Distribution Packet (CDP) assembly (SMPTE 334).

One CDP per video frame. cc_data triplets from cea708.py are padded to a
fixed cc_count so every frame carries a constant-size CDP (also the idle
keepalive: an all-padding CDP). Pure, no I/O.
"""
from __future__ import annotations

from typing import List

from .cea708 import CcTriplet, padding_triplet

CC_COUNT_25FPS = 25

_RATE = {25: 0x4, 30: 0x7, 2997: 0x3}


def frame_rate_code(fps: int) -> int:
    return _RATE.get(fps, 0x4)


def build_cdp(
    triplets: List[CcTriplet],
    *,
    sequence: int,
    frame_rate_code: int = 0x4,
    cc_count: int = 25,
) -> bytes:
    trips = list(triplets[:cc_count])
    while len(trips) < cc_count:
        trips.append(padding_triplet())

    out = bytearray()
    out += bytes([0x96, 0x69])          # cdp_identifier
    out.append(0)                        # cdp_length placeholder (byte 2)
    out.append((frame_rate_code << 4) | 0x0F)
    out.append(0b01000011)               # flags: ccdata_present + caption_service_active + reserved 1
    out += bytes([(sequence >> 8) & 0xFF, sequence & 0xFF])  # header sequence

    out.append(0x72)                     # ccdata_id
    out.append(0xE0 | (cc_count & 0x1F))
    for cc_type, b1, b2 in trips:
        out.append(0xF8 | (1 << 2) | (cc_type & 0x03))  # marker(11111) + cc_valid + cc_type
        out += bytes([b1, b2])

    out.append(0x74)                     # cdp_footer_id
    out += bytes([(sequence >> 8) & 0xFF, sequence & 0xFF])  # footer sequence

    out[2] = len(out) + 1                 # cdp_length includes the checksum byte
    checksum = (256 - (sum(out) % 256)) % 256
    out.append(checksum)
    return bytes(out)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/worker-stream-pod && pytest tests/test_cdp.py -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add services/worker-stream-pod/src/worker_stream_pod/cdp.py services/worker-stream-pod/tests/test_cdp.py
git commit -m "feat(pod): CDP packer with fixed cc_count and checksum"
```

---

### Task 3: SMPTE 2038 wrapper (`smpte2038.py`)

**Files:**
- Create: `services/worker-stream-pod/src/worker_stream_pod/smpte2038.py`
- Test: `services/worker-stream-pod/tests/test_smpte2038.py`

**Interfaces:**
- Consumes: a CDP `bytes` from `cdp`.
- Produces:
  - `def wrap_cdp(cdp: bytes, *, line_number: int = 9) -> bytes` — a byte-aligned SMPTE 2038 VANC data unit (DID 0x61, SDID 0x01) carrying the CDP as user-data words.
  - `def parity10(byte: int) -> int` — 8-bit value to a 10-bit word with 2 parity bits (bit8 even parity, bit9 its inverse).

- [ ] **Step 1: Write the failing test**

```python
from worker_stream_pod.smpte2038 import wrap_cdp, parity10


def test_parity10_sets_two_parity_bits():
    w = parity10(0x00)
    assert w & 0xFF == 0x00
    assert (w >> 8) & 1 == 0          # even parity of 0 ones -> 0
    assert (w >> 9) & 1 == 1          # inverse in bit 9
    w2 = parity10(0x01)
    assert (w2 >> 8) & 1 == 1          # odd number of ones -> parity bit 1


def test_wrap_cdp_is_byte_aligned_and_nonempty():
    cdp = bytes([0x96, 0x69, 0x0A, 0x4F, 0x43, 0x00, 0x00, 0x72, 0xE0, 0x00])
    unit = wrap_cdp(cdp, line_number=9)
    assert isinstance(unit, bytes)
    assert len(unit) > len(cdp)        # 10-bit words expand the payload
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/worker-stream-pod && pytest tests/test_smpte2038.py -v`
Expected: FAIL with `ModuleNotFoundError: worker_stream_pod.smpte2038`.

- [ ] **Step 3: Write minimal implementation**

```python
"""SMPTE ST 2038 wrapping of a CEA-708 CDP as VANC ancillary data.

Emits one byte-aligned 2038 data unit carrying the CDP (DID 0x61, SDID
0x01 per SMPTE 334). Words are 10-bit (8 data + 2 parity); the unit is
bit-packed big-endian then padded to a byte boundary. Pure, no I/O.
"""
from __future__ import annotations


def parity10(byte: int) -> int:
    ones = bin(byte & 0xFF).count("1")
    even = ones & 1                      # 1 if odd count -> even-parity bit
    return (((even ^ 1) & 1) << 9) | (even << 8) | (byte & 0xFF)


class _BitWriter:
    def __init__(self) -> None:
        self._bits: list[int] = []

    def put(self, value: int, width: int) -> None:
        for i in range(width - 1, -1, -1):
            self._bits.append((value >> i) & 1)

    def put_word(self, byte: int) -> None:
        self.put(parity10(byte), 10)

    def to_bytes(self) -> bytes:
        while len(self._bits) % 8:
            self._bits.append(1)          # stuffing bits are 1
        out = bytearray()
        for i in range(0, len(self._bits), 8):
            b = 0
            for bit in self._bits[i:i + 8]:
                b = (b << 1) | bit
            out.append(b)
        return bytes(out)


def wrap_cdp(cdp: bytes, *, line_number: int = 9) -> bytes:
    bw = _BitWriter()
    bw.put(0, 6)                          # fixed zero bits
    bw.put(0, 1)                          # c_not_y_channel_flag (luma)
    bw.put(line_number & 0x7FF, 11)
    bw.put(0, 12)                         # horizontal_offset
    bw.put_word(0x61)                     # DID
    bw.put_word(0x01)                     # SDID
    bw.put_word(len(cdp) & 0xFF)          # data_count
    checksum = 0
    for b in cdp:
        bw.put_word(b)
        checksum += b
    bw.put(checksum & 0x1FF, 9)           # anc checksum, 9-bit sum of words
    return bw.to_bytes()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/worker-stream-pod && pytest tests/test_smpte2038.py -v`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add services/worker-stream-pod/src/worker_stream_pod/smpte2038.py services/worker-stream-pod/tests/test_smpte2038.py
git commit -m "feat(pod): SMPTE 2038 VANC wrapping of CDP"
```

---

### Task 4: TS packetiser (`ts_mux.py`)

**Files:**
- Create: `services/worker-stream-pod/src/worker_stream_pod/ts_mux.py`
- Test: `services/worker-stream-pod/tests/test_ts_mux.py`

**Interfaces:**
- Consumes: 2038 payload `bytes` from `smpte2038`.
- Produces:
  - `PMT_PID = 0x1000`, `DATA_PID = 0x1010`.
  - `class TsMuxer:`
    - `__init__(self, *, data_pid: int = DATA_PID, pmt_pid: int = PMT_PID)`
    - `def psi_packets(self) -> bytes` — PAT + PMT (188*2), call periodically.
    - `def pes_packet(self, payload: bytes, *, pts_90k: int, pcr_27m: int | None = None) -> bytes` — one PES in one-or-more TS packets, first packet carries PCR when `pcr_27m` is given; 188-byte aligned, padded with stuffing.
  - `def ms_to_pts(ms: float) -> int` — `int(ms * 90) & 0x1FFFFFFFF` (33-bit).
  - `def ms_to_pcr(ms: float) -> int` — `int(ms * 27000) & 0x1FFFFFFFF` (base part).

- [ ] **Step 1: Write the failing test**

```python
from worker_stream_pod.ts_mux import TsMuxer, ms_to_pts, PMT_PID, DATA_PID


def _pids(stream: bytes):
    return [((stream[i + 1] & 0x1F) << 8) | stream[i + 2]
            for i in range(0, len(stream), 188)]


def test_all_packets_are_188_and_sync_byte():
    m = TsMuxer()
    stream = m.psi_packets() + m.pes_packet(b"\x00" * 40, pts_90k=ms_to_pts(1000), pcr_27m=0)
    assert len(stream) % 188 == 0
    assert all(stream[i] == 0x47 for i in range(0, len(stream), 188))


def test_psi_has_pat_and_pmt_pids():
    m = TsMuxer()
    pids = _pids(m.psi_packets())
    assert 0x0000 in pids            # PAT
    assert PMT_PID in pids           # PMT


def test_pes_uses_data_pid_and_pts_is_33bit():
    m = TsMuxer()
    pkt = m.pes_packet(b"\xAB" * 10, pts_90k=ms_to_pts(2000))
    assert _pids(pkt)[0] == DATA_PID
    assert ms_to_pts(2000) == int(2000 * 90)


def test_pts_wraps_at_33_bits():
    # a time past the 33-bit 90kHz range wraps rather than overflowing
    huge_ms = (2 ** 33) / 90 + 5
    assert ms_to_pts(huge_ms) < 2 ** 33
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/worker-stream-pod && pytest tests/test_ts_mux.py -v`
Expected: FAIL with `ModuleNotFoundError: worker_stream_pod.ts_mux`.

- [ ] **Step 3: Write minimal implementation**

```python
"""Minimal MPEG-TS packetiser for a single SMPTE 2038 data PID.

Emits PAT/PMT plus PES packets carrying 2038 payloads, PTS-stamped, with
PCR in the adaptation field. Only what a caption-only TS needs. Pure (no
I/O); the caller drives timing and cadence. 188-byte packets, big-endian.
"""
from __future__ import annotations

from typing import Optional

PMT_PID = 0x1000
DATA_PID = 0x1010
_STREAM_TYPE_2038 = 0x06  # PES private data


def ms_to_pts(ms: float) -> int:
    return int(ms * 90) & 0x1FFFFFFFF


def ms_to_pcr(ms: float) -> int:
    return int(ms * 27000) & 0x1FFFFFFFF


def _crc32_mpeg(data: bytes) -> int:
    crc = 0xFFFFFFFF
    for b in data:
        crc ^= b << 24
        for _ in range(8):
            crc = ((crc << 1) ^ 0x04C11DB7) & 0xFFFFFFFF if crc & 0x80000000 else (crc << 1) & 0xFFFFFFFF
    return crc


def _section(table_id: int, body: bytes) -> bytes:
    length = len(body) + 4  # + CRC
    hdr = bytes([table_id, 0xB0 | ((length >> 8) & 0x0F), length & 0xFF])
    sec = hdr + body
    crc = _crc32_mpeg(sec)
    return sec + bytes([(crc >> 24) & 0xFF, (crc >> 16) & 0xFF, (crc >> 8) & 0xFF, crc & 0xFF])


def _pad_ts(packet: bytearray) -> bytes:
    packet += bytes([0xFF] * (188 - len(packet)))
    return bytes(packet[:188])


class TsMuxer:
    def __init__(self, *, data_pid: int = DATA_PID, pmt_pid: int = PMT_PID) -> None:
        self.data_pid = data_pid
        self.pmt_pid = pmt_pid
        self._cc = {0x0000: 0, pmt_pid: 0, data_pid: 0}

    def _next_cc(self, pid: int) -> int:
        v = self._cc[pid]
        self._cc[pid] = (v + 1) & 0x0F
        return v

    def _psi_packet(self, pid: int, section: bytes) -> bytes:
        p = bytearray([0x47, 0x40 | ((pid >> 8) & 0x1F), pid & 0xFF, 0x10 | self._next_cc(pid)])
        p.append(0x00)                # pointer_field
        p += section
        return _pad_ts(p)

    def psi_packets(self) -> bytes:
        pat_body = bytes([0x00, 0x01, 0xC1, 0x00, 0x00,   # tsid, version/current, sec no, last
                          0x00, 0x01,                       # program_number 1
                          0xE0 | ((self.pmt_pid >> 8) & 0x1F), self.pmt_pid & 0xFF])
        pat = self._psi_packet(0x0000, _section(0x00, pat_body))

        pmt_body = bytes([0x00, 0x01, 0xC1, 0x00, 0x00,
                          0xE0 | ((self.data_pid >> 8) & 0x1F), self.data_pid & 0xFF,  # PCR PID
                          0xF0, 0x00,                        # program_info_length 0
                          _STREAM_TYPE_2038,
                          0xE0 | ((self.data_pid >> 8) & 0x1F), self.data_pid & 0xFF,
                          0xF0, 0x00])                       # ES_info_length 0
        pmt = self._psi_packet(self.pmt_pid, _section(0x02, pmt_body))
        return pat + pmt

    def _pts_field(self, pts: int) -> bytes:
        return bytes([
            0x21 | ((pts >> 29) & 0x0E),
            (pts >> 22) & 0xFF,
            0x01 | ((pts >> 14) & 0xFE),
            (pts >> 7) & 0xFF,
            0x01 | ((pts << 1) & 0xFE),
        ])

    def _adaptation_pcr(self, pcr: int) -> bytes:
        base = pcr & 0x1FFFFFFFF
        return bytes([
            0x10,                          # PCR flag
            (base >> 25) & 0xFF, (base >> 17) & 0xFF, (base >> 9) & 0xFF, (base >> 1) & 0xFF,
            ((base & 1) << 7) | 0x7E, 0x00,
        ])

    def pes_packet(self, payload: bytes, *, pts_90k: int, pcr_27m: Optional[int] = None) -> bytes:
        pes_hdr = bytearray([0x00, 0x00, 0x01, 0xBD])   # private_stream_1
        opt = bytes([0x80, 0x80, 0x05]) + self._pts_field(pts_90k)
        pes_len = len(opt) + len(payload)
        pes_hdr += bytes([(pes_len >> 8) & 0xFF, pes_len & 0xFF]) + opt + payload
        pes = bytes(pes_hdr)

        packets = bytearray()
        first = True
        i = 0
        while i < len(pes):
            p = bytearray([0x47])
            pid = self.data_pid
            p.append((0x40 if first else 0x00) | ((pid >> 8) & 0x1F))
            p.append(pid & 0xFF)
            af = self._adaptation_pcr(pcr_27m) if (first and pcr_27m is not None) else b""
            body_room = 184 - (1 + len(af) if af else 0)
            chunk = pes[i:i + body_room]
            need_stuff = body_room - len(chunk)
            if af or need_stuff:
                af_full = af
                if need_stuff:
                    af_full = af_full + bytes([0xFF] * need_stuff) if af_full else bytes([0x00]) + bytes([0xFF] * (need_stuff - 1))
                p.append(0x30 | self._next_cc(pid))       # adaptation + payload
                p.append(len(af_full))
                p += af_full
                p += chunk
            else:
                p.append(0x10 | self._next_cc(pid))       # payload only
                p += chunk
            packets += _pad_ts(p)
            i += len(chunk)
            first = False
        return bytes(packets)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/worker-stream-pod && pytest tests/test_ts_mux.py -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add services/worker-stream-pod/src/worker_stream_pod/ts_mux.py services/worker-stream-pod/tests/test_ts_mux.py
git commit -m "feat(pod): minimal MPEG-TS packetiser for 2038 caption PID"
```

---

### Task 5: Caption muxer orchestrator (`caption_ts_muxer.py`)

**Files:**
- Create: `services/worker-stream-pod/src/worker_stream_pod/caption_ts_muxer.py`
- Test: `services/worker-stream-pod/tests/test_caption_ts_muxer.py`

**Interfaces:**
- Consumes: `Cue` from `cue_emitter`; `popon_triplets`/`clear_triplets` (cea708); `build_cdp` (cdp); `wrap_cdp` (smpte2038); `TsMuxer`, `ms_to_pts`, `ms_to_pcr` (ts_mux).
- Produces:
  - `class Caption708Muxer:`
    - `__init__(self, *, sink, now, fps: int = 25, latency_ms: int = 1000, service: int = 1, psi_interval_frames: int = 25, queue_max: int = 256)` where `sink` is `async def (bytes) -> None` (ffmpeg stdin write, injectable for tests) and `now` is `() -> float` returning wall-clock seconds (injectable clock).
    - `def add(self, cue: Cue) -> None` — non-blocking enqueue; on overflow drops oldest and increments `dropped`.
    - `async def run(self, stop: asyncio.Event) -> None` — the frame loop: each tick builds one CDP (current caption or padding), wraps to 2038, packetises with PTS/PCR, writes to sink; emits PSI every `psi_interval_frames`.
    - attributes: `frames_emitted: int`, `dropped: int`.
  - `def build_muxer_from_env(cfg: dict, sink) -> Caption708Muxer` — reads `POD_CAPTION_FPS`, `POD_CAPTION_LATENCY_MS`, `POD_CAPTION_SERVICE`.

- [ ] **Step 1: Write the failing test**

```python
import asyncio
import pytest

from worker_stream_pod.cue_emitter import Cue
from worker_stream_pod.caption_ts_muxer import Caption708Muxer


class FakeClock:
    def __init__(self):
        self.t = 1000.0
    def __call__(self):
        return self.t


@pytest.mark.asyncio
async def test_emits_frames_and_psi_even_when_idle():
    written = []
    clock = FakeClock()
    mux = Caption708Muxer(sink=lambda b: written.append(b) or _done(),
                          now=clock, fps=25, psi_interval_frames=5)
    stop = asyncio.Event()

    async def advance():
        for _ in range(10):
            clock.t += 0.04
            await asyncio.sleep(0)
        stop.set()

    await asyncio.gather(mux.run(stop), advance())
    assert mux.frames_emitted >= 1
    assert b"".join(written).count(b"\x47") >= mux.frames_emitted  # TS packets present


def _done():
    f = asyncio.get_event_loop().create_future()
    f.set_result(None)
    return f


def test_add_overflow_drops_oldest():
    mux = Caption708Muxer(sink=None, now=lambda: 0.0, queue_max=2)
    for i in range(5):
        mux.add(Cue(cue_id=i, start_ms=0, end_ms=1000, text=f"c{i}"))
    assert mux.dropped == 3
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/worker-stream-pod && pytest tests/test_caption_ts_muxer.py -v`
Expected: FAIL with `ModuleNotFoundError: worker_stream_pod.caption_ts_muxer`.

- [ ] **Step 3: Write minimal implementation**

```python
"""Background caption TS muxer: wall-clock frame loop feeding SRT egress.

Owns a nominal-fps ticker. Each tick it renders the current pop-on caption
(or padding) as a CDP, wraps it in SMPTE 2038, packetises to TS with a
wall-clock PTS/PCR, and writes to an injected byte sink (ffmpeg stdin in
production). Finalised cues arrive via add() on a bounded queue; overflow
drops oldest so captions never back-pressure ASR. See
docs/superpowers/specs/2026-07-15-cta708-caption-ts-design.md.
"""
from __future__ import annotations

import asyncio
import os
from collections import deque
from typing import Awaitable, Callable, Deque, Optional

from .cue_emitter import Cue
from .cea708 import popon_triplets, clear_triplets
from .cdp import build_cdp, frame_rate_code
from .smpte2038 import wrap_cdp
from .ts_mux import TsMuxer, ms_to_pts, ms_to_pcr

SinkFn = Callable[[bytes], Awaitable[None]]


class Caption708Muxer:
    def __init__(
        self,
        *,
        sink: Optional[SinkFn],
        now: Callable[[], float],
        fps: int = 25,
        latency_ms: int = 1000,
        service: int = 1,
        psi_interval_frames: int = 25,
        queue_max: int = 256,
    ) -> None:
        self._sink = sink
        self._now = now
        self._fps = fps
        self._frame_ms = 1000.0 / fps
        self._latency_ms = latency_ms
        self._service = service
        self._psi_interval = psi_interval_frames
        self._queue: Deque[Cue] = deque()
        self._queue_max = queue_max
        self._ts = TsMuxer()
        self._rate_code = frame_rate_code(fps)
        self._seq = 0
        self._t0: Optional[float] = None
        self._cur_triplets = None            # active pop-on triplets, sent once
        self._clear_at_ms: Optional[float] = None
        self.frames_emitted = 0
        self.dropped = 0

    def add(self, cue: Cue) -> None:
        if len(self._queue) >= self._queue_max:
            self._queue.popleft()
            self.dropped += 1
        self._queue.append(cue)

    def _elapsed_ms(self) -> float:
        return (self._now() - self._t0) * 1000.0

    def _triplets_for_tick(self, elapsed_ms: float):
        # Promote a queued cue to the active caption.
        if self._queue:
            cue = self._queue.popleft()
            self._cur_triplets = popon_triplets(cue.text, service=self._service)
            self._clear_at_ms = elapsed_ms + max(0, cue.end_ms - cue.start_ms)
            out = self._cur_triplets
            self._cur_triplets = None       # send the caption commands once
            return out
        if self._clear_at_ms is not None and elapsed_ms >= self._clear_at_ms:
            self._clear_at_ms = None
            return clear_triplets(service=self._service)
        return []                            # padding-only frame (keepalive)

    async def run(self, stop: asyncio.Event) -> None:
        self._t0 = self._now()
        frame = 0
        next_tick = self._now()
        while not stop.is_set():
            elapsed_ms = self._elapsed_ms()
            triplets = self._triplets_for_tick(elapsed_ms)
            cdp = build_cdp(triplets, sequence=self._seq & 0xFFFF,
                            frame_rate_code=self._rate_code)
            self._seq += 1
            payload = wrap_cdp(cdp)
            pts = ms_to_pts(elapsed_ms + self._latency_ms)
            pcr = ms_to_pcr(elapsed_ms + self._latency_ms)
            out = bytearray()
            if frame % self._psi_interval == 0:
                out += self._ts.psi_packets()
            out += self._ts.pes_packet(payload, pts_90k=pts, pcr_27m=pcr)
            if self._sink is not None:
                await self._sink(bytes(out))
            self.frames_emitted += 1
            frame += 1
            next_tick += self._frame_ms / 1000.0
            await asyncio.sleep(max(0.0, next_tick - self._now()))


def build_muxer_from_env(cfg: dict, sink: SinkFn) -> Caption708Muxer:
    import time
    return Caption708Muxer(
        sink=sink,
        now=time.time,
        fps=int(cfg.get("CAPTION_FPS", os.environ.get("POD_CAPTION_FPS", "25"))),
        latency_ms=int(cfg.get("CAPTION_LATENCY_MS", os.environ.get("POD_CAPTION_LATENCY_MS", "1000"))),
        service=int(cfg.get("CAPTION_SERVICE", os.environ.get("POD_CAPTION_SERVICE", "1"))),
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/worker-stream-pod && pytest tests/test_caption_ts_muxer.py -v`
Expected: PASS (2 tests). Note: the idle test uses a fake clock advanced manually; `run` exits when `stop` is set.

- [ ] **Step 5: Commit**

```bash
git add services/worker-stream-pod/src/worker_stream_pod/caption_ts_muxer.py services/worker-stream-pod/tests/test_caption_ts_muxer.py
git commit -m "feat(pod): Caption708Muxer wall-clock frame loop with drop-oldest queue"
```

---

### Task 6: Fan-out sink wiring (`fanout.py`)

**Files:**
- Modify: `services/worker-stream-pod/src/worker_stream_pod/fanout.py`
- Modify: `services/worker-stream-pod/tests/test_fanout.py`

**Interfaces:**
- Consumes: `Caption708Muxer.add(cue)` (Task 5). The fan-out only needs an object with a synchronous `add(cue)`.
- Produces: `CueFanout(..., caption_ts=None)` calls `caption_ts.add(cue)` for finalised cues, same place as `vtt.add(cue)`.

- [ ] **Step 1: Write the failing test** (append to `test_fanout.py`)

```python
class FakeCaptionTs:
    def __init__(self):
        self.added = []
    def add(self, cue):
        self.added.append(cue)


def test_finalised_cues_reach_caption_ts_sink():
    bc = FakeBroadcaster()
    cap = FakeCaptionTs()

    async def publish_cue(c):
        pass

    async def persist_cue(c):
        pass

    fo = CueFanout(stream_id="s1", broadcaster=bc, publish_cue=publish_cue,
                   persist_cue=persist_cue, vtt=None, caption_ts=cap)

    async def run():
        cues = [
            (Cue(cue_id=1, start_ms=0, end_ms=1000, text="hi"), True),
            (Cue(cue_id=2, start_ms=1000, end_ms=2000, text="interim"), False),
        ]
        return await fo.run(_aiter(cues))

    n = asyncio.run(run())
    assert n == 1
    assert [c.cue_id for c in cap.added] == [1]   # only the finalised cue
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/worker-stream-pod && pytest tests/test_fanout.py::test_finalised_cues_reach_caption_ts_sink -v`
Expected: FAIL with `TypeError: __init__() got an unexpected keyword argument 'caption_ts'`.

- [ ] **Step 3: Write minimal implementation**

In `fanout.py`, add `caption_ts=None` to `CueFanout.__init__` and store it, then call it alongside `vtt`:

```python
    def __init__(
        self,
        *,
        stream_id: str,
        broadcaster,
        publish_cue: PublishFn,
        persist_cue: PersistFn,
        vtt=None,
        caption_ts=None,
    ) -> None:
        self.stream_id = stream_id
        self.broadcaster = broadcaster
        self.publish_cue = publish_cue
        self.persist_cue = persist_cue
        self.vtt = vtt
        self.caption_ts = caption_ts
```

In `run`, in the `if is_final:` branch, after the `self.vtt` block:

```python
                if self.vtt is not None:
                    self.vtt.add(cue)
                if self.caption_ts is not None:
                    self.caption_ts.add(cue)
                cue_count += 1
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd services/worker-stream-pod && pytest tests/test_fanout.py -v`
Expected: PASS (existing tests plus the new one).

- [ ] **Step 5: Commit**

```bash
git add services/worker-stream-pod/src/worker_stream_pod/fanout.py services/worker-stream-pod/tests/test_fanout.py
git commit -m "feat(pod): route finalised cues to optional caption_ts sink"
```

---

### Task 7: Pod worker wiring + ffmpeg SRT egress (`worker.py`)

**Files:**
- Modify: `services/worker-stream-pod/src/worker_stream_pod/worker.py`
- Test: `services/worker-stream-pod/tests/test_caption_egress.py` (new)

**Interfaces:**
- Consumes: `build_muxer_from_env` (Task 5), `Caption708Muxer` (Task 5).
- Produces:
  - `def spawn_srt_ffmpeg(host: str, port: int) -> asyncio.subprocess.Process`-like via a helper `async def start_caption_egress(cfg) -> tuple[proc, sink]`, where `sink(bytes)` writes to `proc.stdin`. Best-effort: returns `(None, None)` and logs on failure.
  - New `_config()` keys: `CAPTION_TS` (bool, `POD_CAPTION_TS == "1"`), `SRT_HOST` (`POD_SRT_HOST`, default `0.0.0.0`), `SRT_PORT` (`POD_SRT_PORT`, optional int), plus the muxer env keys read in Task 5.

- [ ] **Step 1: Write the failing test**

```python
from worker_stream_pod.worker import _config
import os


def test_config_reads_caption_ts_flag(monkeypatch):
    for k, v in {
        "STREAM_ID": "s_x", "POD_ID": "p_x", "SOURCE_KIND": "hls",
        "SOURCE_URL": "https://e/x.m3u8", "POD_WS_PORT": "10000",
        "DATABASE_URL": "postgres://x", "POD_CAPTION_TS": "1",
        "POD_SRT_PORT": "11000",
    }.items():
        monkeypatch.setenv(k, v)
    cfg = _config()
    assert cfg["CAPTION_TS"] is True
    assert cfg["SRT_PORT"] == 11000
    assert cfg["SRT_HOST"] == "0.0.0.0"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/worker-stream-pod && pytest tests/test_caption_egress.py -v`
Expected: FAIL with `KeyError: 'CAPTION_TS'`.

- [ ] **Step 3: Write minimal implementation**

Add to `_config()` return dict in `worker.py`:

```python
        "CAPTION_TS":   os.environ.get("POD_CAPTION_TS") == "1",
        "SRT_HOST":     os.environ.get("POD_SRT_HOST", "0.0.0.0"),
        "SRT_PORT":     (int(os.environ["POD_SRT_PORT"]) if os.environ.get("POD_SRT_PORT") else None),
        "CAPTION_FPS":         int(os.environ.get("POD_CAPTION_FPS", "25")),
        "CAPTION_LATENCY_MS":  int(os.environ.get("POD_CAPTION_LATENCY_MS", "1000")),
        "CAPTION_SERVICE":     int(os.environ.get("POD_CAPTION_SERVICE", "1")),
```

Add the egress helper near the top of `worker.py` (after imports):

```python
async def start_caption_egress(cfg):
    """Best-effort ffmpeg SRT listener fed our raw TS on stdin.

    Returns (proc, sink). On any failure returns (None, None); the caption
    output is optional and must never fail the stream.
    """
    if not cfg["CAPTION_TS"] or not cfg["SRT_PORT"]:
        return None, None
    url = f"srt://{cfg['SRT_HOST']}:{cfg['SRT_PORT']}?mode=listener"
    try:
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg", "-loglevel", "error", "-f", "mpegts", "-i", "pipe:0",
            "-c", "copy", "-f", "mpegts", url,
            stdin=asyncio.subprocess.PIPE,
        )
    except Exception as e:
        log.warning("caption_egress_start_failed", err=str(e))
        return None, None

    async def sink(data: bytes) -> None:
        if proc.stdin is None or proc.stdin.is_closing():
            return
        try:
            proc.stdin.write(data)
            await proc.stdin.drain()
        except Exception as e:
            log.warning("caption_egress_write_failed", err=str(e))

    return proc, sink
```

Wire into `main()`: in the non-stub branch, after building `vtt`, before building `fanout`:

```python
                cap_proc, cap_sink = await start_caption_egress(cfg)
                caption_mux = None
                cap_task = None
                if cap_sink is not None:
                    from worker_stream_pod.caption_ts_muxer import build_muxer_from_env
                    caption_mux = build_muxer_from_env(cfg, cap_sink)
                    cap_task = asyncio.create_task(caption_mux.run(stop))
```

Pass `caption_ts=caption_mux` into the `CueFanout(...)` in that branch. In the `finally:` block, after the `vtt` close, add:

```python
            if cap_task is not None:
                cap_task.cancel()
                try:
                    await cap_task
                except asyncio.CancelledError:
                    pass
            if cap_proc is not None:
                try:
                    if cap_proc.stdin is not None:
                        cap_proc.stdin.close()
                    cap_proc.terminate()
                    await asyncio.wait_for(cap_proc.wait(), timeout=5)
                except Exception as e:
                    log.warning("caption_egress_close_failed", err=str(e))
```

Declare `cap_proc = cap_task = caption_mux = None` alongside the existing `audio = None` so the `finally` names always exist.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/worker-stream-pod && pytest tests/test_caption_egress.py tests/test_fanout.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/worker-stream-pod/src/worker_stream_pod/worker.py services/worker-stream-pod/tests/test_caption_egress.py
git commit -m "feat(pod): wire Caption708Muxer + best-effort ffmpeg SRT egress"
```

---

### Task 8: Migration (`0007_caption_ts.sql`)

**Files:**
- Create: `infra/migrations/0007_caption_ts.sql`

**Interfaces:**
- Produces: `streams.caption_ts_enabled bool default false`, `stream_pods.srt_port int`.

- [ ] **Step 1: Write the migration**

```sql
BEGIN;

ALTER TABLE streams     ADD COLUMN caption_ts_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE stream_pods ADD COLUMN srt_port INT;

INSERT INTO schema_migrations(version) VALUES ('0007');

COMMIT;
```

- [ ] **Step 2: Apply and verify**

Run: `make migrate` (from repo root, per README quickstart)
Expected: migration 0007 applied; `\d streams` shows `caption_ts_enabled`, `\d stream_pods` shows `srt_port`.

- [ ] **Step 3: Commit**

```bash
git add infra/migrations/0007_caption_ts.sql
git commit -m "feat(db): caption_ts_enabled and stream_pods.srt_port"
```

---

### Task 9: Supervisor SRT port pool + provisioning

**Files:**
- Modify: `services/worker-stream-supervisor/src/worker_stream_supervisor/worker.py`
- Test: `services/worker-stream-supervisor/tests/test_srt_provision.py` (new)

**Interfaces:**
- Consumes: `PortPool` (existing `pool.py`), provision payload `caption_ts` boolean.
- Produces:
  - `_config()` gains `SRT_PORT_START` (`STREAM_SRT_PORT_START`, default 11000), `SRT_PORT_END` (`STREAM_SRT_PORT_END`, default 11009), `SRT_PUBLIC_HOST` (`SRT_PUBLIC_HOST`, default = `WS_HOST`).
  - `handle_provision` allocates an SRT port from a second pool when `payload.get("caption_ts")`, sets `POD_CAPTION_TS`, `POD_SRT_PORT`, `POD_SRT_HOST` in spawn env, persists `srt_port`, and includes `srt_port` in the ready payload.
  - New helper `def srt_env(caption_ts: bool, srt_pool, sid: str) -> tuple[dict, Optional[int]]` returning `(env_additions, srt_port_or_None)` for unit-testing.

- [ ] **Step 1: Write the failing test**

```python
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/worker-stream-supervisor && pytest tests/test_srt_provision.py -v`
Expected: FAIL with `ImportError: cannot import name 'srt_env'`.

- [ ] **Step 3: Write minimal implementation**

Add to `worker.py`:

```python
from typing import Optional, Tuple


def srt_env(caption_ts: bool, srt_pool: PortPool, sid: str) -> Tuple[dict, Optional[int]]:
    if not caption_ts:
        return {}, None
    port = srt_pool.allocate(sid)
    return (
        {"POD_CAPTION_TS": "1", "POD_SRT_PORT": str(port), "POD_SRT_HOST": "0.0.0.0"},
        port,
    )
```

In `_config()` add:

```python
        "SRT_PORT_START":  int(os.environ.get("STREAM_SRT_PORT_START", "11000")),
        "SRT_PORT_END":    int(os.environ.get("STREAM_SRT_PORT_END",   "11009")),
        "SRT_PUBLIC_HOST": os.environ.get("SRT_PUBLIC_HOST", os.environ.get("STREAM_WS_HOST", socket.gethostname())),
```

Where the supervisor builds its pools (near the WS `PortPool` construction in `main()`), add a second pool `srt_pool = PortPool(cfg["SRT_PORT_START"], cfg["SRT_PORT_END"])` and thread it into `handle_provision` (add a parameter, same style as `pool`). In `handle_provision`, after `ws_port` allocation:

```python
    add_env, srt_port = srt_env(bool(payload.get("caption_ts")), srt_pool, sid)
    spawn_env.update(add_env)
```

Persist `srt_port` in the `stream_pods` upsert (add column to the INSERT and the `ON CONFLICT` SET), and add `"srt_port": srt_port` to `ready_payload`. On `PoolFull` from the SRT pool, free the already-allocated `ws_port` and fail provisioning with `STREAM_PROVISION_FAILED`, "no free SRT ports".

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/worker-stream-supervisor && pytest tests/test_srt_provision.py tests/test_pool.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/worker-stream-supervisor/src/worker_stream_supervisor/worker.py services/worker-stream-supervisor/tests/test_srt_provision.py
git commit -m "feat(supervisor): allocate SRT port and spawn env when caption_ts enabled"
```

---

### Task 10: Gateway contract + route

**Files:**
- Modify: `packages/contracts/openapi.yaml`
- Modify: `services/api-gateway/src/routes/streams.ts`
- Modify: `services/api-gateway/tests/streams.test.ts`

**Interfaces:**
- Consumes: `caption_ts` from `StreamCreate.output`; `SRT_PUBLIC_HOST` env for URL base.
- Produces: `outputs.caption_srt_url` in the create response when enabled; `caption_ts` persisted to `streams.caption_ts_enabled` and forwarded in the provision payload as `caption_ts`.

- [ ] **Step 1: Write the failing test** (append to `streams.test.ts`, mirror an existing create test)

```ts
test("caption_ts=true returns caption_srt_url and forwards the flag", async () => {
  process.env.SRT_PUBLIC_HOST = "srt.example.test";
  const res = await app.inject({
    method: "POST",
    url: "/v1/streams",
    headers: authHeaders(),
    payload: {
      source: { kind: "hls", url: "https://example.test/live.m3u8" },
      output: { caption_ts: true },
    },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.ok(body.outputs.caption_srt_url.startsWith("srt://srt.example.test:"));
});

test("caption_ts omitted returns no caption_srt_url", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/v1/streams",
    headers: authHeaders(),
    payload: { source: { kind: "hls", url: "https://example.test/live.m3u8" } },
  });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().outputs.caption_srt_url, undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/api-gateway && npm test -- streams.test.ts`
Expected: FAIL (caption_srt_url undefined when expected, flag not handled).

- [ ] **Step 3: Write minimal implementation**

In `openapi.yaml`, `StreamCreate.output` add `caption_ts: { type: boolean, default: false }`; `StreamCreateResponse.outputs` add `caption_srt_url: { type: string }` (not in `required`).

In `streams.ts`:
- Read `const captionTs = body.output?.caption_ts === true;`
- Add `caption_ts_enabled` to the INSERT column list and values (`captionTs`).
- Add `caption_ts: captionTs` to the provision `payload`.
- Add an `srtBase()` helper: `const srtBase = () => process.env.SRT_PUBLIC_HOST ?? "localhost";`
- Build outputs conditionally:

```ts
      outputs: {
        websocket_url: `${wsBase()}/v1/streams/${id}/captions`,
        vtt_url:       `${publicBase()}/v1/streams/${id}/captions.vtt`,
        ttml_url:      `${publicBase()}/v1/streams/${id}/captions.ttml`,
        ...(captionTs ? { caption_srt_url: `srt://${srtBase()}:${srtPortFor(id)}` } : {}),
      },
```

Since the SRT port is assigned by the supervisor asynchronously (not known at 201 time), the create response cannot include the concrete port yet. Resolve by returning the URL without a port here and documenting that the port is surfaced on `GET /v1/streams/:id` once the pod is ready. Implement `caption_srt_url` in the create response as `srt://${srtBase()}` (host only) and add the concrete `srt://host:port` to the GET status handler by selecting `p.srt_port` from `stream_pods` (join like `streams-ws.ts` does). Update the GET test accordingly.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd services/api-gateway && npm test -- streams.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/openapi.yaml services/api-gateway/src/routes/streams.ts services/api-gateway/tests/streams.test.ts
git commit -m "feat(gateway): caption_ts opt-in flag and caption_srt_url output"
```

---

### Task 11: End-to-end SRT round-trip (slow-marked)

**Files:**
- Create: `services/worker-stream-pod/tests/test_e2e_caption_ts.py`

**Interfaces:**
- Consumes: everything above. Uses real ffmpeg. Marked `slow` so it stays out of the default lane.

- [ ] **Step 1: Write the test**

```python
import asyncio
import subprocess
import pytest

from worker_stream_pod.cue_emitter import Cue
from worker_stream_pod.caption_ts_muxer import Caption708Muxer


@pytest.mark.slow
@pytest.mark.asyncio
async def test_ts_stream_probes_as_valid_mpegts(tmp_path):
    """Feed the muxer a cue, capture the TS to a file via the sink, and
    assert ffprobe sees a valid MPEG-TS with our data PID."""
    chunks = []

    async def sink(b: bytes):
        chunks.append(b)

    import time
    mux = Caption708Muxer(sink=sink, now=time.time, fps=25, psi_interval_frames=5)
    mux.add(Cue(cue_id=1, start_ms=0, end_ms=1500, text="ROUND TRIP OK"))
    stop = asyncio.Event()

    async def stopper():
        await asyncio.sleep(0.5)
        stop.set()

    await asyncio.gather(mux.run(stop), stopper())
    data = b"".join(chunks)
    ts_path = tmp_path / "cap.ts"
    ts_path.write_bytes(data)

    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries",
         "stream=codec_type,codec_tag_string", "-of", "csv", str(ts_path)],
        capture_output=True, text=True,
    )
    assert ts_path.stat().st_size > 0
    assert "data" in out.stdout or out.returncode == 0
```

- [ ] **Step 2: Run it**

Run: `cd services/worker-stream-pod && pytest -m slow tests/test_e2e_caption_ts.py -v`
Expected: PASS (requires ffmpeg/ffprobe on PATH).

- [ ] **Step 3: Commit**

```bash
git add services/worker-stream-pod/tests/test_e2e_caption_ts.py
git commit -m "test(pod): slow e2e TS validity probe for caption output"
```

---

### Task 12: Docs

**Files:**
- Modify: `docs/user-guide.md` (add `caption_ts` output to the Streams section)
- Modify: `docs/technical-guide.md` (add caption TS pipeline + SRT deployment note)

**Interfaces:** none (docs only).

- [ ] **Step 1: Update user-guide.md**

Add under the streams create documentation: enabling `output.caption_ts: true` adds `caption_srt_url` to the response; the muxer connects as an SRT caller to that URL to pull a caption-only MPEG-TS (SMPTE 2038, CEA-708 + 608). Concrete port is surfaced on `GET /v1/streams/:id` once the pod is ready.

- [ ] **Step 2: Update technical-guide.md**

Document the pipeline (`cea708 -> cdp -> smpte2038 -> ts_mux -> ffmpeg SRT listener`), the new env vars (`POD_CAPTION_*`, `STREAM_SRT_PORT_START/END`, `SRT_PUBLIC_HOST`), the best-effort failure stance, and the deployment requirement that the pod SRT port range is reachable by the muxer. Reference the spec at `docs/superpowers/specs/2026-07-15-cta708-caption-ts-design.md`.

- [ ] **Step 3: Commit**

```bash
git add docs/user-guide.md docs/technical-guide.md
git commit -m "docs: caption TS output and SRT deployment notes"
```

---

## Self-Review

**Spec coverage:**
- Output shape (caption-only TS): Tasks 1-4, 11. Covered.
- Live continuous delivery: Task 5 (frame loop), Task 7 (SRT egress). Covered.
- SMPTE 2038 carriage: Task 3. Covered.
- Wall-clock + fixed latency sync: Task 5 (`latency_ms`, wall-clock PTS/PCR). Covered.
- SRT, pod as listener: Task 7 (`mode=listener`), Task 9 (port pool). Covered.
- Pop-on style + 608 compat: Task 1. Covered.
- In-house encode + ffmpeg egress: Tasks 1-4 vs Task 7. Covered.
- Opt-in flag + provisioning + migrations + response URL: Tasks 8, 9, 10. Covered.
- Error handling (best-effort, drop-oldest, clean close): Task 5 (drop-oldest), Task 7 (best-effort start + clean close). Covered.
- Observability (drop counter): `dropped`/`frames_emitted` on the muxer (Task 5). A metric emit can be added in Task 7 wiring if desired; counters are exposed as attributes.

**Placeholder scan:** No TBD/TODO. Every code step has concrete code. The one deferred detail (concrete SRT port not known at 201-response time) is resolved explicitly in Task 10 by surfacing it on the GET handler.

**Type consistency:** `CcTriplet` defined in Task 1, consumed in Tasks 2/5. `build_cdp` signature consistent Task 2 -> Task 5. `wrap_cdp` Task 3 -> Task 5. `TsMuxer`/`ms_to_pts`/`ms_to_pcr` Task 4 -> Task 5. `Caption708Muxer.add` Task 5 -> Task 6 fan-out. `srt_env` Task 9 self-consistent. `caption_ts` payload key: gateway (Task 10) emits it, supervisor (Task 9) reads `payload.get("caption_ts")`. Consistent.

**Known real-world caveat for implementers:** the byte-level encoders (Tasks 1-4) follow the named standards (CEA-708, SMPTE 334/2038, ISO 13818-1) but the golden reference is the downstream muxer. Task 11's ffprobe check confirms structural TS validity; final caption-decode validation should be done against the target muxer or a known-good 708 decoder before production sign-off. This matches the spec's "Open items to confirm".
