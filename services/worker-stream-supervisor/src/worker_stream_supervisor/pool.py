from dataclasses import dataclass, field
from typing import Dict, List


class PoolFull(Exception):
    pass


@dataclass
class PortPool:
    start: int
    end: int
    _in_use: Dict[str, int] = field(default_factory=dict)
    _free: List[int] = field(default_factory=list)

    def __post_init__(self) -> None:
        self._free = list(range(self.start, self.end + 1))

    def allocate(self, stream_id: str) -> int:
        if stream_id in self._in_use:
            return self._in_use[stream_id]
        if not self._free:
            raise PoolFull(f"port pool exhausted ({self.start}-{self.end})")
        port = self._free.pop(0)
        self._in_use[stream_id] = port
        return port

    def free(self, stream_id: str) -> None:
        port = self._in_use.pop(stream_id, None)
        if port is not None and port not in self._free:
            self._free.append(port)
            self._free.sort()

    def in_use_count(self) -> int:
        return len(self._in_use)
