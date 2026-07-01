FROM python:3.11-slim

WORKDIR /app

# Upgrade base tools to mitigate package vulns
RUN apt-get update && apt-get install -y --no-install-recommends \
    && pip install --upgrade pip setuptools wheel \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt requirements-dev.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]