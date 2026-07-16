#!/usr/bin/env bash
# Runs under busybox sh (compose entrypoint: ["sh", ...]), which lacks `pipefail`.
set -eu
URL="${NATS_URL:-nats://nats:4222}"

nats --server "$URL" stream add AUDIO_WORK \
  --subjects "audio.work.>" \
  --storage file --retention limits --max-age 7d \
  --max-msgs=-1 --max-bytes=-1 --discard old \
  --replicas 1 --defaults || true

nats --server "$URL" stream add AUDIO_EVENTS \
  --subjects "audio.event.>" \
  --storage file --retention limits --max-age 24h \
  --max-msgs=-1 --max-bytes=-1 --discard old \
  --replicas 1 --defaults || true

nats --server "$URL" stream add AUDIO_STREAMS \
  --subjects "audio.stream.>" \
  --storage file --retention limits --max-age 24h \
  --max-msgs=-1 --max-bytes=-1 --discard old \
  --replicas 1 --defaults || true

echo "Streams ready."
