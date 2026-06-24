import os
import subprocess
from dataclasses import dataclass, field
from typing import Dict, List


@dataclass
class Forker:
    cmd: List[str]
    _procs: Dict[str, subprocess.Popen] = field(default_factory=dict)

    def spawn(self, stream_id: str, env: Dict[str, str]) -> int:
        merged = {**os.environ, **env}
        p = subprocess.Popen(self.cmd, env=merged)
        self._procs[stream_id] = p
        return p.pid

    def terminate(self, stream_id: str) -> None:
        p = self._procs.pop(stream_id, None)
        if p is None or p.poll() is not None:
            return
        p.terminate()
        try:
            p.wait(timeout=5)
        except subprocess.TimeoutExpired:
            p.kill()

    def active_count(self) -> int:
        return sum(1 for p in self._procs.values() if p.poll() is None)
