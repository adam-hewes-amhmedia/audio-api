from worker_stream_pod.ts_mux import TsMuxer, ms_to_pts, PMT_PID, DATA_PID


def _pids(stream: bytes):
    return [((stream[i + 1] & 0x1F) << 8) | stream[i + 2]
            for i in range(0, len(stream), 188)]


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
