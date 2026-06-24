import asyncio
import json
from typing import Set

import websockets


class CueBroadcaster:
    def __init__(self) -> None:
        self.subs: Set[websockets.WebSocketServerProtocol] = set()
        self.lock = asyncio.Lock()

    async def register(self, ws) -> None:
        async with self.lock:
            self.subs.add(ws)

    async def unregister(self, ws) -> None:
        async with self.lock:
            self.subs.discard(ws)

    async def broadcast(self, payload: dict) -> None:
        data = json.dumps(payload)
        dead = []
        for ws in list(self.subs):
            try:
                await ws.send(data)
            except Exception:
                dead.append(ws)
        for ws in dead:
            await self.unregister(ws)


async def serve_ws(broadcaster: CueBroadcaster, host: str, port: int):
    async def handler(ws):
        await broadcaster.register(ws)
        try:
            await ws.wait_closed()
        finally:
            await broadcaster.unregister(ws)
    return await websockets.serve(handler, host, port)
