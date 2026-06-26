FROM python:3.12-slim
# The supervisor forks the pod in-process (python -m worker_stream_pod), so this
# image needs the pod's runtime too: ffmpeg for the source pull/decode.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir --upgrade pip
WORKDIR /app
COPY packages/py-common /app/packages/py-common
COPY services/worker-stream-supervisor /app/services/worker-stream-supervisor
COPY services/worker-stream-pod /app/services/worker-stream-pod
WORKDIR /app/services/worker-stream-supervisor
RUN pip install --no-cache-dir -e ../../packages/py-common
RUN pip install --no-cache-dir -e ../worker-stream-pod
RUN pip install --no-cache-dir -e .
# Whisper/Silero model cache (mount a volume in prod to avoid re-downloads).
ENV HF_HOME=/models MODEL_CACHE_DIR=/models
RUN mkdir -p /models && useradd -u 1000 -m runner && chown -R runner:runner /app /models
USER runner
CMD ["python", "-m", "worker_stream_supervisor"]
