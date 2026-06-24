import sys
import time
from pathlib import Path
from worker_stream_supervisor.forker import Forker


def test_forker_spawns_python_subprocess(tmp_path: Path):
    marker = tmp_path / "ran.txt"
    code = f"open(r'{marker}', 'w').write('ok')"
    f = Forker(cmd=[sys.executable, "-c", code])
    f.spawn(stream_id="s1", env={"STREAM_ID": "s1"})
    for _ in range(50):
        if marker.exists():
            break
        time.sleep(0.05)
    assert marker.read_text() == "ok"
    f.terminate("s1")
    assert f.active_count() == 0
