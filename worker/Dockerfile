FROM python:3.11-slim

WORKDIR /app

# Upgrade base tools to mitigate package vulns
RUN apt-get update && apt-get install -y --no-install-recommends \
    && pip install --upgrade pip setuptools wheel \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt requirements-dev.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY clip_processor ./clip_processor

CMD ["python", "-c", "from clip_processor.main import process_video; print(process_video('test'))"]