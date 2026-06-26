FROM python:3.12-slim
# ffmpeg provides the HLS/DASH/MP4 pull + decode for the audio source.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir --upgrade pip
WORKDIR /app
COPY packages/py-common /app/packages/py-common
COPY services/worker-stream-pod /app/services/worker-stream-pod
WORKDIR /app/services/worker-stream-pod
RUN pip install --no-cache-dir -e ../../packages/py-common
RUN pip install --no-cache-dir -e .
# faster-whisper / silero models are cached here; mount a volume in prod to
# avoid re-downloading on every pod start.
ENV HF_HOME=/models MODEL_CACHE_DIR=/models
RUN mkdir -p /models && useradd -u 1000 -m runner && chown -R runner:runner /app /models
USER runner
CMD ["python", "-m", "worker_stream_pod"]
