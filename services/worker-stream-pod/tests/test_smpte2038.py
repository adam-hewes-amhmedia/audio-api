from worker_stream_pod.smpte2038 import (
    wrap_cdp,
    parity10,
    anc_checksum_word,
    _word9,
)


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


def test_anc_checksum_word_matches_smpte291():
    cdp = bytes([0x96, 0x69, 0x0A])
    # Independently compute per SMPTE 291: 9-bit (mod 512) sum of the b0..b8
    # word values of DID, SDID, data_count and every UDW.
    expected_sum = _word9(0x61) + _word9(0x01) + _word9(3)
    for b in cdp:
        expected_sum += _word9(b)
    expected_cs = expected_sum & 0x1FF
    expected_b9 = ((expected_cs >> 8) & 1) ^ 1
    expected_word = (expected_b9 << 9) | expected_cs

    word = anc_checksum_word(0x61, 0x01, 3, cdp)
    assert word == expected_word
    assert (word >> 9) & 1 == ((word >> 8) & 1) ^ 1   # b9 == inverse of b8
    assert 0 <= word < 1024                            # full 10-bit word
