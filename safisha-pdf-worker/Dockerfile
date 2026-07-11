# safisha-pdf-worker · Cloud Run container
# IRON DOME NUCLEAR DESIGN

FROM python:3.12-slim

# System deps for pdfplumber (pdfminer, PIL)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpoppler-cpp-dev \
    libglib2.0-0 \
    libsm6 \
    libxrender1 \
    libxext6 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .

# Cloud Run injects PORT env var
ENV PORT=8080

# Non-root user (security hardening)
RUN adduser --disabled-password --gecos "" appuser
USER appuser

CMD ["python", "main.py"]
