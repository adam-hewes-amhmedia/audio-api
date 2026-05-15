FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libsndfile1 wget && rm -rf /var/lib/apt/lists/*
RUN useradd -u 1000 -m runner

# Pre-download PANNs assets so import + AudioTagging() succeed without network at runtime.
# The library uses os.system('wget ...') to fetch these on first use, which silently fails
# in the slim image (no wget) and then crashes on the file open.
# Zenodo is historically flaky; retry the model wget with backoff so a transient 5xx during
# build doesn't fail it.
RUN mkdir -p /home/runner/panns_data && \
    wget -O /home/runner/panns_data/class_labels_indices.csv \
        "http://storage.googleapis.com/us_audioset/youtube_corpus/v1/csv/class_labels_indices.csv" && \
    wget --tries=10 --waitretry=30 --retry-connrefused \
        --retry-on-http-error=429,500,502,503,504 \
        -O "/home/runner/panns_data/Cnn14_mAP=0.431.pth" \
        "https://zenodo.org/record/3987831/files/Cnn14_mAP%3D0.431.pth?download=1" && \
    chown -R runner:runner /home/runner/panns_data

WORKDIR /app
COPY packages/py-common /app/packages/py-common
COPY services/worker-dme-classify /app/services/worker-dme-classify
WORKDIR /app/services/worker-dme-classify
RUN pip install --no-cache-dir -e ../../packages/py-common && \
    pip install --no-cache-dir -e . && \
    chown -R runner:runner /app
USER runner
CMD ["python", "-m", "worker_dme_classify"]
