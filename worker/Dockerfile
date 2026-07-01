FROM python:3.12-slim

WORKDIR /app

# Upgrade base tools and OS packages to mitigate known vulnerabilities in base image
RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends \
    && pip install --upgrade pip setuptools wheel \
    && apt-get purge -y perl-base perl perl-modules || true \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt requirements-dev.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY clip_processor ./clip_processor

CMD ["python", "-c", "from clip_processor.main import process_video; print(process_video('test'))"]