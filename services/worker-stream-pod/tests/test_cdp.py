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
