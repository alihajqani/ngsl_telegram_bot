# Forced-alignment sidecar. See app.py for the API.
#
# CPU-only PyTorch, pinned: torchaudio 2.5 still ships `forced_align` and
# `merge_tokens`, which later releases deprecate. The model weights are baked
# in at build time so the container never needs the network at runtime.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    TORCH_HOME=/opt/torch

RUN pip install --index-url https://download.pytorch.org/whl/cpu torch==2.5.1 torchaudio==2.5.1 \
 && pip install numpy==2.1.3

# UID 1000 matches the worker's `node` user, and the scratch path exists here
# too, so whichever container first mounts the shared volume creates it with
# ownership the worker can write to. The directories are owned before the
# model is fetched: a `chown -R` afterwards would copy the 380 MB of weights
# into a second layer.
RUN useradd --uid 1000 --create-home aligner \
 && mkdir -p /tmp/ngsl-clips /opt/torch \
 && chown aligner:aligner /tmp/ngsl-clips /opt/torch

USER aligner
RUN python -c "import torchaudio; torchaudio.pipelines.WAV2VEC2_ASR_BASE_960H.get_model()"

COPY app.py /app/app.py
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health')"
CMD ["python", "/app/app.py"]
