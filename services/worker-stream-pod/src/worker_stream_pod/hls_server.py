"""Tiny static HTTP server for the local HLS preview dir.

Serves only index.m3u8 and seg-*.ts from one directory, with the right content
types. Refuses anything that resolves outside the dir. Runs in the pod alongside
the captions WS server; the gateway proxies it.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

_CT = {".m3u8": "application/vnd.apple.mpegurl", ".ts": "video/mp2t"}


async def serve_hls(hls_dir: str, host: str, port: int) -> asyncio.AbstractServer:
    root = Path(hls_dir).resolve()

    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        try:
            line = await asyncio.wait_for(reader.readline(), timeout=5)
            parts = line.decode("latin1").split()
            # Drain the rest of the request headers.
            while True:
                h = await asyncio.wait_for(reader.readline(), timeout=5)
                if h in (b"\r\n", b"\n", b""):
                    break
            if len(parts) < 2 or parts[0] != "GET":
                return await _respond(writer, 400, b"", "text/plain")
            name = parts[1].split("?", 1)[0].lstrip("/")
            target = (root / name).resolve()
            # Reject traversal and unknown extensions.
            if root not in target.parents or target.suffix not in _CT or not target.is_file():
                return await _respond(writer, 404, b"", "text/plain")
            await _respond(writer, 200, target.read_bytes(), _CT[target.suffix])
        except Exception:
            try:
                await _respond(writer, 500, b"", "text/plain")
            except Exception:
                pass

    async def _respond(writer, status, body, ct):
        reason = {200: "OK", 400: "Bad Request", 404: "Not Found", 500: "Internal Server Error"}.get(status, "OK")
        head = (
            f"HTTP/1.1 {status} {reason}\r\n"
            f"content-type: {ct}\r\n"
            f"content-length: {len(body)}\r\n"
            f"cache-control: no-cache\r\n"
            f"connection: close\r\n\r\n"
        ).encode("latin1")
        writer.write(head + body)
        try:
            await writer.drain()
        finally:
            writer.close()

    return await asyncio.start_server(handle, host, port)
