FROM python:3.12-slim

WORKDIR /app

# Upgrade base tools and OS packages to mitigate known vulnerabilities in base image
RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends \
    && pip install --upgrade pip setuptools wheel \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt requirements-dev.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]