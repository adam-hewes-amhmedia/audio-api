from worker_stream_pod.cea708 import (
    popon_triplets,
    clear_triplets,
    padding_triplet,
    _dtvcc_popon_bytes,
)


def _parse_service_blocks(block_bytes):
    """Walk concatenated DTVCC service blocks, returning (declared_size, chunk)."""
    parsed = []
    pos = 0
    while pos < len(block_bytes):
        header = block_bytes[pos]
        size = header & 0x1F
        chunk = block_bytes[pos + 1:pos + 1 + size]
        parsed.append((size, chunk))
        pos += 1 + size
    return parsed


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


def test_long_caption_splits_into_valid_service_blocks():
    blocks = _dtvcc_popon_bytes("X" * 50, service=1)
    parsed = _parse_service_blocks(blocks)
    # 50 chars plus command overhead exceeds one 31-byte service block
    assert len(parsed) >= 2
    for size, chunk in parsed:
        # every declared block size fits the 5-bit size field
        assert size <= 31
        # and matches the actual following chunk length
        assert size == len(chunk)
    # the whole thing fits inside a single DTVCC packet
    assert len(blocks) <= 127


def test_clear_emits_both_608_eod_and_708_hide():
    trips = clear_triplets(service=1)
    # 608 field-1 Erase Displayed Memory (EDM) 0x14 0x2C
    assert (0, 0x14, 0x2C) in trips
    # at least one 708 triplet present
    assert any(t[0] in (2, 3) for t in trips)
