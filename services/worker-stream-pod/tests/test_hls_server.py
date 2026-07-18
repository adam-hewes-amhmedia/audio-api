import asyncio
import urllib.request
from pathlib import Path

from worker_stream_pod.hls_server import serve_hls


def test_serves_a_file_and_rejects_traversal(tmp_path):
    (tmp_path / "index.m3u8").write_text("#EXTM3U\n")

    async def run():
        server = await serve_hls(str(tmp_path), "127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]
        loop = asyncio.get_event_loop()
        try:
            # The client call is blocking I/O; run it off-thread so it doesn't
            # starve this same-thread asyncio server of the chance to accept
            # and answer the connection (a blocking call here would otherwise
            # deadlock the single-threaded event loop against itself).
            ok = await loop.run_in_executor(
                None, lambda: urllib.request.urlopen(f"http://127.0.0.1:{port}/index.m3u8", timeout=2).read()
            )
            assert b"#EXTM3U" in ok

            # Path traversal must be refused, not served.
            def _fetch_traversal():
                try:
                    urllib.request.urlopen(f"http://127.0.0.1:{port}/../secret", timeout=2)
                    return 200
                except urllib.error.HTTPError as e:
                    return e.code

            bad = await loop.run_in_executor(None, _fetch_traversal)
            assert bad in (400, 403, 404)
        finally:
            server.close()
            await server.wait_closed()

    asyncio.run(run())
