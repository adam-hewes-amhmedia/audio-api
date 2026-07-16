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
