# Postman collection

Two files:

- `audio-api.postman_collection.json` — request collection.
- `audio-api.postman_environment.json` — `Audio API (local)` env with `base_url`, `ws_url`, dev `token`, and slots for `job_id` / `stream_id` (auto-populated by request test scripts).

## Import

1. Postman → `Import` → drag both JSON files.
2. Top-right environment dropdown → select `Audio API (local)`.

## Use

- Run **Health → GET /v1/health** first to confirm the stack is up.
- **Streams → POST /v1/streams** saves the returned `stream_id` to the env automatically, so **GET** and **DELETE** in the same folder just work.
- **Jobs → POST /v1/jobs** does the same for `job_id`.

## WebSocket

Postman v2.1 collection format doesn't natively serialise WebSocket requests. To test the live captions feed:

1. In Postman, click `New` → `WebSocket Request`.
2. URL: `ws://localhost:8080/v1/streams/{{stream_id}}/captions` (uses the env-saved `stream_id`).
3. Headers: `Authorization: Bearer {{token}}`.
4. Click **Connect**. Cue events arrive as JSON every ~5 seconds (stub source; Plan 6 makes them real).

## Production / other envs

Duplicate the environment, change `base_url` and `ws_url`, and swap `token` for the real bearer.
