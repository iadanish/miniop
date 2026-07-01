FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt requirements-dev.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY clip_processor ./clip_processor

CMD ["python", "-c", "from clip_processor.main import process_video; print(process_video('test'))"]