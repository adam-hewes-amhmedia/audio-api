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
