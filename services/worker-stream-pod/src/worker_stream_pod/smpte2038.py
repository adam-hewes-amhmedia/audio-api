"""SMPTE ST 2038 wrapping of a CEA-708 CDP as VANC ancillary data.

Emits one byte-aligned 2038 data unit carrying the CDP (DID 0x61, SDID
0x01 per SMPTE 334). Words are 10-bit (8 data + 2 parity); the unit is
bit-packed big-endian then padded to a byte boundary. Pure, no I/O.
"""
from __future__ import annotations


def parity10(byte: int) -> int:
    ones = bin(byte & 0xFF).count("1")
    parity_bit = ones & 1                # b8: 1 when popcount is odd (even parity)
    return (((parity_bit ^ 1) & 1) << 9) | (parity_bit << 8) | (byte & 0xFF)


def _word9(byte: int) -> int:
    # low 9 bits (data + even-parity bit b8) of the 10-bit anc word
    return parity10(byte) & 0x1FF


def anc_checksum_word(did: int, sdid: int, data_count: int, udw: bytes) -> int:
    # SMPTE 291 anc checksum: 9-bit sum (mod 512) of the b0..b8 word values
    # of DID, SDID, data_count and every UDW; returned as a full 10-bit word
    # with b9 = inverse of b8.
    total = _word9(did) + _word9(sdid) + _word9(data_count & 0xFF)
    for b in udw:
        total += _word9(b)
    cs = total & 0x1FF                    # 9-bit checksum value
    b9 = ((cs >> 8) & 1) ^ 1
    return (b9 << 9) | cs


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
    for b in cdp:
        bw.put_word(b)
    bw.put(anc_checksum_word(0x61, 0x01, len(cdp) & 0xFF, cdp), 10)  # anc checksum
    return bw.to_bytes()
