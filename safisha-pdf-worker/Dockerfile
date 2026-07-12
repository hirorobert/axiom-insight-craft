# safisha-pdf-worker · Cloud Run container
# IRON DOME NUCLEAR DESIGN
#
# Includes:
#   - pdfplumber (PDF text + table extraction)
#   - Arelle (XBRL 2.1 + iXBRL 1.1 validator — Apache 2.0)
#   - lxml (fast XML processing for XBRL generation)
#   - xbrl_engine.py (SAFF XBRL generator)
#
# Arelle taxonomy cache:
#   On first /generate-xbrl call, Arelle downloads the IFRS taxonomy from
#   http://xbrl.ifrs.org/taxonomy/ and caches it in /home/appuser/.arelle/cache/.
#   Cloud Run instances share the cache across warm starts.
#   For air-gapped deployments, mount a pre-populated cache volume.

FROM python:3.12-slim

# System deps:
#   libpoppler-cpp-dev   — pdfplumber/pdfminer PDF parsing
#   libglib2.0-0         — PIL image support
#   libsm6, libxrender1, libxext6 — PIL display deps
#   libxml2-dev          — lxml (XBRL XML processing)
#   libxslt1-dev         — lxml XSLT (used by Arelle)
#   ca-certificates      — HTTPS for Arelle taxonomy downloads from ifrs.org
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpoppler-cpp-dev \
    libglib2.0-0 \
    libsm6 \
    libxrender1 \
    libxext6 \
    libxml2-dev \
    libxslt1-dev \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .
COPY xbrl_engine.py .

# Arelle taxonomy cache directory (persistent across warm starts)
RUN mkdir -p /home/appuser/.arelle/cache

# Cloud Run injects PORT env var
ENV PORT=8080

# Non-root user (security hardening)
RUN adduser --disabled-password --gecos "" appuser \
    && chown -R appuser /home/appuser/.arelle
USER appuser

CMD ["python", "main.py"]
