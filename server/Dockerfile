# syntax=docker/dockerfile:1
# LocaLingo Learn server. Build from the repository root:
#   docker compose -f server/compose.yaml up -d --build
# (the build context is the repo root so the image can include the web app files
#  from extension/ and the dictionary builder from scripts/).

# --- Stage 1: build dictionary packages from a pinned ECDICT commit ---------------
FROM python:3.12-slim AS dict
ARG ECDICT_COMMIT=bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b
ARG ECDICT_SHA256=1a6947e04785db63613a92e14903cdae7954f7e84860b10e68e5c7cbb3f9c3cf
WORKDIR /build
COPY scripts/build_dict.py .
RUN python - <<EOF
import hashlib, urllib.request
base = "https://raw.githubusercontent.com/skywind3000/ECDICT/${ECDICT_COMMIT}/"
urllib.request.urlretrieve(base + "ecdict.csv", "ecdict.csv")
urllib.request.urlretrieve(base + "LICENSE", "ECDICT-LICENSE.txt")
digest = hashlib.sha256(open("ecdict.csv", "rb").read()).hexdigest()
assert digest == "${ECDICT_SHA256}", f"ECDICT checksum mismatch: {digest}"
EOF
RUN python build_dict.py ecdict.csv --license ECDICT-LICENSE.txt --commit ${ECDICT_COMMIT} --out /dist \
    && rm ecdict.csv

# --- Stage 2: server -------------------------------------------------------------------
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    LOCALINGO_DATA=/data LOCALINGO_WEB_ROOT=/app/web LOCALINGO_DICT_DIR=/app/dict
WORKDIR /app
COPY server/pyproject.toml server/README.md /app/server/
COPY server/localingo_server /app/server/localingo_server
RUN pip install --no-cache-dir /app/server
COPY extension/learn.html /app/web/learn.html
COPY extension/learn /app/web/learn
COPY extension/learning /app/web/learning
COPY extension/icons /app/web/icons
COPY --from=dict /dist /app/dict
RUN useradd --system --uid 10001 localingo && mkdir -p /data && chown localingo /data
USER localingo
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/api/health')"
CMD ["uvicorn", "localingo_server.app:app", "--host", "0.0.0.0", "--port", "8080", "--proxy-headers", "--forwarded-allow-ips", "*"]
