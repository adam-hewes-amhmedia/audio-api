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


def test_dtvcc_packet_size_code_counts_padded_words():
    # The size code must count the packet header byte + data padded up to whole
    # 16-bit words. "TEST" yields an even-length service block, "HELLO" an odd
    # one; both must declare the padded word count, not the pre-pad length.
    for text in ("TEST", "HELLO"):
        dtvcc = _dtvcc_popon_bytes(text, service=1)
        expected = -(-(1 + len(dtvcc)) // 2)  # ceil((1 + len) / 2)
        trips = popon_triplets(text, service=1)
        # size code lives in the low 6 bits of the cc_type 3 triplet's first byte
        start = next(t for t in trips if t[0] == 3)
        code = start[1] & 0x3F
        code = 64 if code == 0 else code  # 0 means 64 words per spec
        assert code == expected


def test_long_caption_truncates_to_one_packet_with_controls_intact():
    blocks = _dtvcc_popon_bytes("A" * 130, service=1)
    # truncation keeps the whole thing inside one DTVCC packet
    assert len(blocks) <= 127
    # reassemble the command stream (strip service-block headers)
    cmd = b"".join(chunk for _, chunk in _parse_service_blocks(blocks))
    # trailing ETX + DisplayWindows control bytes survive the truncation
    assert cmd[-3:] == bytes([0x03, 0x89, 0x01])


def test_clear_emits_both_608_eod_and_708_hide():
    trips = clear_triplets(service=1)
    # 608 field-1 Erase Displayed Memory (EDM) 0x14 0x2C
    assert (0, 0x14, 0x2C) in trips
    # at least one 708 triplet present
    assert any(t[0] in (2, 3) for t in trips)
