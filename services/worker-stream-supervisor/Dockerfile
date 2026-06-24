FROM python:3.12-slim
RUN pip install --no-cache-dir --upgrade pip
WORKDIR /app
COPY packages/py-common /app/packages/py-common
COPY services/worker-stream-supervisor /app/services/worker-stream-supervisor
WORKDIR /app/services/worker-stream-supervisor
RUN pip install --no-cache-dir -e ../../packages/py-common
RUN pip install --no-cache-dir -e .
RUN useradd -u 1000 -m runner && chown -R runner:runner /app
USER runner
CMD ["python", "-m", "worker_stream_supervisor"]
