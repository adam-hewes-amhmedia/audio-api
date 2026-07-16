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
