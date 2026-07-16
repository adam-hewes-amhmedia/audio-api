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
