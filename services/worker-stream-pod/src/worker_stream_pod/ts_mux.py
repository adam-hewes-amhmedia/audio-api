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
        # pcr is a 27MHz tick count; the wire field is base (90kHz, 33 bits)
        # plus a 9-bit extension (27MHz, 0..299), not the raw 27MHz value.
        base = (pcr // 300) & 0x1FFFFFFFF
        ext = pcr % 300
        return bytes([
            0x10,                          # PCR flag
            (base >> 25) & 0xFF, (base >> 17) & 0xFF, (base >> 9) & 0xFF, (base >> 1) & 0xFF,
            ((base & 1) << 7) | 0x7E | ((ext >> 8) & 0x01), ext & 0xFF,
        ])

    def pes_packet(self, payload: bytes, *, pts_90k: int, pcr_27m: Optional[int] = None) -> bytes:
        pes_hdr = bytearray([0x00, 0x00, 0x01, 0xBD])   # private_stream_1
        opt = bytes([0x80, 0x80, 0x05]) + self._pts_field(pts_90k)
        pes_len = len(opt) + len(payload)
        pes_hdr += bytes([(pes_len >> 8) & 0xFF, pes_len & 0xFF]) + opt + payload
        pes = bytes(pes_hdr)

        packets = bytearray()
        pid = self.data_pid
        first = True
        i = 0
        n = len(pes)
        while i < n:
            remaining = n - i
            use_pcr = first and pcr_27m is not None
            p = bytearray([0x47, (0x40 if first else 0x00) | ((pid >> 8) & 0x1F), pid & 0xFF])
            if remaining >= 184 and not use_pcr:
                # fills the packet exactly: payload only, no adaptation field
                chunk = pes[i:i + 184]
                p.append(0x10 | self._next_cc(pid))       # payload only
                p += chunk
            else:
                # adaptation field required: for PCR, and/or to stuff the
                # final short chunk out to a full 188-byte packet. The
                # adaptation content length (flags byte, plus PCR fields
                # when present) must be reserved *before* slicing the
                # chunk, or the packet overflows 188 bytes and silently
                # loses payload when padded/truncated back down.
                min_content = 7 if use_pcr else 1   # flags byte (+6 PCR bytes)
                chunk_max = 183 - min_content
                chunk = pes[i:i + chunk_max]
                stuff_len = chunk_max - len(chunk)
                af_content = (self._adaptation_pcr(pcr_27m) if use_pcr else bytes([0x00]))
                af_content += bytes([0xFF] * stuff_len)
                p.append(0x30 | self._next_cc(pid))       # adaptation + payload
                p.append(len(af_content))
                p += af_content
                p += chunk
            packets += _pad_ts(p)
            i += len(chunk)
            first = False
        return bytes(packets)
