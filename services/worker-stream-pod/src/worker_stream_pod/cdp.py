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
