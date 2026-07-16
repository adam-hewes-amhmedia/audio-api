from worker_stream_pod.ts_mux import TsMuxer, ms_to_pts, ms_to_pcr, PMT_PID, DATA_PID


def _pids(stream: bytes):
    return [((stream[i + 1] & 0x1F) << 8) | stream[i + 2]
            for i in range(0, len(stream), 188)]


def _recover_pes_payload(stream: bytes) -> bytes:
    # Walk 188-byte packets, skip TS header (+ adaptation field when the
    # afc bits say one is present), concatenate the payload bytes, then
    # strip the PES header to recover the original payload.
    pes = bytearray()
    for i in range(0, len(stream), 188):
        p = stream[i:i + 188]
        afc = (p[3] >> 4) & 0x03
        off = 4
        if afc in (2, 3):                 # adaptation field present
            off += 1 + p[4]               # length byte + adaptation content
        if afc in (1, 3):                 # payload present
            pes += p[off:188]
    # PES header: 00 00 01 BD, 2-byte length, 80 80 05, then 5 PTS bytes
    assert pes[:4] == b"\x00\x00\x01\xBD"
    assert pes[6:9] == b"\x80\x80\x05"
    return bytes(pes[14:])


def test_all_packets_are_188_and_sync_byte():
    m = TsMuxer()
    stream = m.psi_packets() + m.pes_packet(b"\x00" * 40, pts_90k=ms_to_pts(1000), pcr_27m=0)
    assert len(stream) % 188 == 0
    assert all(stream[i] == 0x47 for i in range(0, len(stream), 188))


def test_psi_has_pat_and_pmt_pids():
    m = TsMuxer()
    pids = _pids(m.psi_packets())
    assert 0x0000 in pids            # PAT
    assert PMT_PID in pids           # PMT


def test_pes_uses_data_pid_and_pts_is_33bit():
    m = TsMuxer()
    pkt = m.pes_packet(b"\xAB" * 10, pts_90k=ms_to_pts(2000))
    assert _pids(pkt)[0] == DATA_PID
    assert ms_to_pts(2000) == int(2000 * 90)


def test_pts_wraps_at_33_bits():
    # a time past the 33-bit 90kHz range wraps rather than overflowing
    huge_ms = (2 ** 33) / 90 + 5
    assert ms_to_pts(huge_ms) < 2 ** 33


def _decode_pcr_seconds(packet: bytes) -> float:
    # First packet must carry an adaptation field with the PCR flag set.
    afc = (packet[3] >> 4) & 0x03
    assert afc in (2, 3)                   # adaptation field present
    af_len = packet[4]
    assert af_len >= 7
    flags = packet[5]
    assert flags & 0x10                    # PCR flag
    b = packet[6:12]                       # 6 PCR bytes
    base = (b[0] << 25) | (b[1] << 17) | (b[2] << 9) | (b[3] << 1) | (b[4] >> 7)
    ext = ((b[4] & 0x01) << 8) | b[5]
    return base / 90000.0 + ext / 27000000.0


def test_pcr_decodes_to_input_time():
    for ms in (1000.0, 5000.0):
        m = TsMuxer()
        pkt = m.pes_packet(b"\x00" * 20, pts_90k=ms_to_pts(ms), pcr_27m=ms_to_pcr(ms))
        seconds = _decode_pcr_seconds(pkt[:188])
        assert abs(seconds - ms / 1000.0) < 1e-6


def test_pes_payload_roundtrips_across_packet_boundary():
    payload = bytes(range(256)) * 2       # 512 bytes, spans multiple packets
    m = TsMuxer()
    stream = m.pes_packet(payload, pts_90k=ms_to_pts(2000))
    assert len(stream) > 188              # genuinely multi-packet
    assert _recover_pes_payload(stream) == payload


def test_pes_payload_roundtrips_at_boundary_sizes():
    # 183/184/185 straddle the single-packet payload boundary, where the
    # off-by-one stuffing bug used to silently drop a trailing byte.
    for size in (183, 184, 185):
        payload = bytes((x % 256) for x in range(size))
        m = TsMuxer()
        stream = m.pes_packet(payload, pts_90k=ms_to_pts(2000))
        assert _recover_pes_payload(stream) == payload


def test_ms_to_pcr_base_does_not_wrap_before_33_bits():
    # The old 33-bit mask on the 27MHz count wrapped the base every ~318s.
    # A time just past that old wrap point (~318.06s) must still exceed one
    # just before it. The buggy version wrapped 319s back down below the
    # 317s value; comparing across the old boundary is what catches it
    # (two points both past the wrap stay ordered even when buggy).
    assert ms_to_pcr(319000) // 300 > ms_to_pcr(317000) // 300
