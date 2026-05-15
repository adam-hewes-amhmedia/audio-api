FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir --upgrade pip
WORKDIR /app
COPY packages/py-common /app/packages/py-common
COPY services/worker-format /app/services/worker-format
WORKDIR /app/services/worker-format
RUN pip install --no-cache-dir -e ../../packages/py-common
RUN pip install --no-cache-dir -e .
RUN useradd -u 1000 -m runner && chown -R runner:runner /app
USER runner
CMD ["python", "-m", "worker_format"]
