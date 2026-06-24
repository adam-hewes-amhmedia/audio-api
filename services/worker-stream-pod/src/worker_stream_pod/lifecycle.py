from datetime import datetime, timezone

from py_common import nats_client


class StatusReporter:
    def __init__(self, js, stream_id: str, pod_id: str) -> None:
        self.js = js
        self.stream_id = stream_id
        self.pod_id = pod_id

    async def mark_started(self) -> None:
        await self.js.publish(
            nats_client.SUBJECTS["STREAM_INGEST_STARTED"],
            nats_client.encode({
                "stream_id": self.stream_id,
                "pod_id":    self.pod_id,
                "started_at": datetime.now(timezone.utc).isoformat(),
            }),
        )

    async def mark_ended(self, reason: str, cue_count: int) -> None:
        await self.js.publish(
            nats_client.SUBJECTS["STREAM_INGEST_ENDED"],
            nats_client.encode({
                "stream_id": self.stream_id,
                "pod_id":    self.pod_id,
                "reason":    reason,
                "cue_count": cue_count,
                "ended_at":  datetime.now(timezone.utc).isoformat(),
            }),
        )
