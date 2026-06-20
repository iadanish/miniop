# MiniOp Queue Architecture

## Overview

MiniOp processes video uploads through a multi-stage pipeline: upload → validate → transcribe → AI analysis → clip extraction → render → store. Each stage is handled by a queue-backed worker system. This document defines the queue architecture for both free-tier single-process and production distributed deployments.

## Architecture

### Free Tier — Single Process with Redis Queue

```
┌──────────┐    ┌─────────┐    ┌──────────────┐
│  Upload  │───▶│  Redis  │───▶│   Worker     │
│   API    │    │  Queue  │    │  (single)    │
└──────────┘    └─────────┘    └──────┬───────┘
                                      │
                              ┌───────▼───────┐
                              │  Processing   │
                              │  Pipeline     │
                              │  (in-process) │
                              └───────────────┘
```

### Production — Distributed Workers with Priority Queues

```
┌──────────┐    ┌─────────────────────────────────┐
│  Upload  │───▶│           Redis Cluster          │
│   API    │    │  ┌──────┐ ┌──────┐ ┌──────────┐ │
└──────────┘    │  │critical│ │ high │ │ default  │ │
                │  │ queue  │ │queue │ │  queue   │ │
                │  └───┬────┘ └──┬───┘ └────┬─────┘ │
                └─────┼─────────┼──────────┼───────┘
                      │         │          │
              ┌───────▼──┐ ┌───▼──────┐ ┌─▼─────────┐
              │ Worker   │ │ Worker   │ │ Worker     │
              │ Pool (2) │ │ Pool (4) │ │ Pool (8)   │
              └──────────┘ └──────────┘ └────────────┘
```

## Queue Definitions

### Core Queues

```python
# minio/queues.py
from enum import Enum

class QueueName(Enum):
    CRITICAL = "jobs:critical"      # Paid urgent, API key priority
    HIGH = "jobs:high"              # Paid standard
    DEFAULT = "jobs:default"        # Free tier
    LOW = "jobs:low"                # Batch processing, retries
    DEAD_LETTER = "jobs:dead_letter" # Failed after max retries
    RETRY = "jobs:retry"            # Scheduled retries (sorted set)

QUEUE_CONFIG = {
    QueueName.CRITICAL: {
        "max_workers": 2,
        "max_concurrent": 4,
        "timeout": 600,
        "retry_count": 3,
    },
    QueueName.HIGH: {
        "max_workers": 4,
        "max_concurrent": 8,
        "timeout": 600,
        "retry_count": 3,
    },
    QueueName.DEFAULT: {
        "max_workers": 8,
        "max_concurrent": 16,
        "timeout": 900,
        "retry_count": 2,
    },
    QueueName.LOW: {
        "max_workers": 2,
        "max_concurrent": 4,
        "timeout": 1800,
        "retry_count": 1,
    },
}
```

### Queue Data Structures

```python
# minio/queue_manager.py
import redis
import json
import time
import uuid
import logging
from typing import Optional
from minio.queues import QueueName, QUEUE_CONFIG

logger = logging.getLogger("minio.queue_manager")

class QueueManager:
    def __init__(self, redis_client: redis.Redis):
        self.redis = redis_client
    
    def enqueue(
        self,
        job_id: str,
        queue: QueueName = QueueName.DEFAULT,
        priority: int = 0,
        delay: int = 0,
        metadata: dict = None,
    ) -> str:
        """Add a job to the specified queue."""
        job_data = {
            "job_id": job_id,
            "queue": queue.value,
            "enqueued_at": time.time(),
            "priority": priority,
            "attempt": 0,
            "metadata": metadata or {},
        }
        
        if delay > 0:
            # Delayed job — add to sorted set with score = execute_at
            execute_at = time.time() + delay
            self.redis.zadd("jobs:scheduled", {json.dumps(job_data): execute_at})
            logger.info(f"Job {job_id} scheduled for {execute_at}")
        else:
            # Immediate — add to queue list
            self.redis.lpush(queue.value, json.dumps(job_data))
            logger.info(f"Job {job_id} enqueued to {queue.value}")
        
        # Track job state
        self.redis.hset(f"job:{job_id}", mapping={
            "status": "queued",
            "queue": queue.value,
            "enqueued_at": time.time(),
            "attempt": 0,
        })
        
        return job_id
    
    def dequeue(self, queue: QueueName, timeout: int = 0) -> Optional[dict]:
        """Remove and return a job from the queue."""
        if timeout > 0:
            result = self.redis.brpop(queue.value, timeout=timeout)
            if result:
                return json.loads(result[1])
            return None
        else:
            result = self.redis.rpop(queue.value)
            if result:
                return json.loads(result)
            return None
    
    def get_queue_depth(self, queue: QueueName) -> int:
        return self.redis.llen(queue.value)
    
    def get_all_queue_depths(self) -> dict:
        depths = {}
        for queue in QueueName:
            if queue != QueueName.DEAD_LETTER:
                depths[queue.value] = self.redis.llen(queue.value)
        depths["jobs:scheduled"] = self.redis.zcard("jobs:scheduled")
        depths["jobs:retry"] = self.redis.zcard("jobs:retry")
        return depths
    
    def get_queue_stats(self) -> dict:
        depths = self.get_all_queue_depths()
        total = sum(depths.values())
        return {
            "queues": depths,
            "total_pending": total,
            "dead_letter": self.redis.llen(QueueName.DEAD_LETTER.value),
        }
```

## Worker Implementation

### Base Worker

```python
# minio/workers/base.py
import redis
import json
import time
import signal
import logging
import threading
from typing import Callable
from minio.queues import QueueName, QUEUE_CONFIG

logger = logging.getLogger("minio.worker")

class Worker:
    def __init__(
        self,
        redis_client: redis.Redis,
        queue: QueueName,
        handler: Callable,
    ):
        self.redis = redis_client
        self.queue = queue
        self.handler = handler
        self.config = QUEUE_CONFIG[queue]
        self.running = False
        self.active_jobs = 0
        self._lock = threading.Lock()
    
    def start(self):
        self.running = True
        signal.signal(signal.SIGTERM, self._handle_shutdown)
        signal.signal(signal.SIGINT, self._handle_shutdown)
        
        logger.info(f"Worker started for {self.queue.value}")
        
        while self.running:
            try:
                if self.active_jobs >= self.config["max_concurrent"]:
                    time.sleep(0.1)
                    continue
                
                job_data = self.redis.brpop(self.queue.value, timeout=1)
                if not job_data:
                    continue
                
                job = json.loads(job_data[1])
                
                with self._lock:
                    self.active_jobs += 1
                
                # Process in thread
                thread = threading.Thread(
                    target=self._process_job,
                    args=(job,),
                    daemon=True,
                )
                thread.start()
                
            except redis.ConnectionError:
                logger.error("Redis connection lost, waiting 5s...")
                time.sleep(5)
            except Exception as e:
                logger.error(f"Worker error: {e}")
                time.sleep(1)
    
    def _process_job(self, job: dict):
        job_id = job["job_id"]
        try:
            # Mark as processing
            self.redis.hset(f"job:{job_id}", mapping={
                "status": "processing",
                "started_at": time.time(),
                "worker_pid": threading.current_thread().ident,
            })
            self.redis.lpush("jobs:processing", job_id)
            
            # Execute handler
            result = self.handler(job)
            
            # Mark as completed
            self.redis.hset(f"job:{job_id}", mapping={
                "status": "completed",
                "completed_at": time.time(),
                "result": json.dumps(result) if result else "{}",
            })
            self.redis.lrem("jobs:processing", 0, job_id)
            
            logger.info(f"Job {job_id} completed")
            
        except Exception as e:
            logger.error(f"Job {job_id} failed: {e}")
            self._handle_failure(job, e)
        
        finally:
            with self._lock:
                self.active_jobs -= 1
    
    def _handle_failure(self, job: dict, error: Exception):
        job_id = job["job_id"]
        attempt = job.get("attempt", 0) + 1
        
        if attempt >= self.config["retry_count"]:
            # Move to dead letter queue
            self.redis.rpush(QueueName.DEAD_LETTER.value, json.dumps({
                **job,
                "attempt": attempt,
                "error": str(error),
                "failed_at": time.time(),
            }))
            self.redis.hset(f"job:{job_id}", mapping={
                "status": "dead_letter",
                "attempt": attempt,
                "error": str(error),
            })
            logger.error(f"Job {job_id} moved to DLQ after {attempt} attempts")
        else:
            # Schedule retry
            delay = min(60 * (2 ** attempt), 900)  # Exponential backoff, max 15 min
            retry_at = time.time() + delay
            self.redis.zadd("jobs:retry", {json.dumps({
                **job, "attempt": attempt
            }): retry_at})
            self.redis.hset(f"job:{job_id}", mapping={
                "status": "retrying",
                "attempt": attempt,
                "error": str(error),
                "retry_at": retry_at,
            })
            logger.warning(f"Job {job_id} scheduled for retry {attempt} at {retry_at}")
        
        self.redis.lrem("jobs:processing", 0, job_id)
    
    def _handle_shutdown(self, signum, frame):
        logger.info(f"Worker shutting down (signal {signum})...")
        self.running = False
        # Wait for active jobs to complete
        deadline = time.time() + 30
        while self.active_jobs > 0 and time.time() < deadline:
            time.sleep(0.5)
```

### Video Processing Worker

```python
# minio/workers/video_worker.py
from minio.workers.base import Worker
from minio.services.video_processor import process_video
from minio.services.storage import StorageService
from minio.services.ai_inference import AIInferenceClient

class VideoWorker(Worker):
    def __init__(self, redis_client, storage: StorageService, ai_client: AIInferenceClient):
        self.storage = storage
        self.ai_client = ai_client
        super().__init__(redis_client, QueueName.DEFAULT, self.process)
    
    def process(self, job: dict) -> dict:
        job_id = job["job_id"]
        video_url = job["metadata"]["video_url"]
        
        # 1. Download video
        video_data = self.storage.download(video_url)
        
        # 2. AI analysis — extract clip timestamps
        clips = self.ai_client.extract_clips(video_url, job["metadata"].get("options", {}))
        
        # 3. Render clips
        rendered = []
        for clip in clips["segments"]:
            output = process_video(
                input_path=video_data,
                output_path=f"/tmp/{job_id}_{clip['id']}.mp4",
                options={
                    "start": clip["start"],
                    "end": clip["end"],
                    "preset": job["metadata"].get("preset", "medium"),
                },
            )
            rendered.append(output)
        
        # 4. Upload rendered clips
        urls = []
        for clip_path in rendered:
            url = self.storage.upload(
                bucket="clips",
                key=f"{job_id}/{clip_path.name}",
                data=open(clip_path, "rb").read(),
                content_type="video/mp4",
            )
            urls.append(url)
        
        return {"clips": urls, "count": len(urls)}
```

## Queue Monitoring

```python
# minio/monitoring/queue_metrics.py
from prometheus_client import Gauge, Counter, Histogram

QUEUE_DEPTH = Gauge(
    'minio_queue_depth',
    'Current queue depth',
    ['queue']
)

QUEUE_PROCESSED = Counter(
    'minio_queue_processed_total',
    'Total jobs processed',
    ['queue', 'status']
)

QUEUE_PROCESSING_TIME = Histogram(
    'minio_queue_processing_seconds',
    'Job processing time',
    ['queue'],
    buckets=[1, 5, 10, 30, 60, 120, 300, 600]
)

WORKER_ACTIVE = Gauge(
    'minio_worker_active_jobs',
    'Active jobs per worker',
    ['queue', 'worker_id']
)

def update_queue_metrics(queue_manager):
    stats = queue_manager.get_queue_stats()
    for queue_name, depth in stats["queues"].items():
        QUEUE_DEPTH.labels(queue=queue_name).set(depth)
    QUEUE_DEPTH.labels(queue="dead_letter").set(stats["dead_letter"])
```

```yaml
# prometheus/alerts/queue.yml
groups:
- name: queue-alerts
  rules:
  - alert: QueueDepthHigh
    expr: minio_queue_depth{queue!="dead_letter"} > 1000
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "Queue {{ $labels.queue }} depth is {{ $value }}"
      
  - alert: DeadLetterGrowing
    expr: minio_queue_depth{queue="dead_letter"} > 50
    for: 10m
    labels:
      severity: critical
    annotations:
      summary: "Dead letter queue has {{ $value }} jobs"
      
  - alert: ProcessingStalled
    expr: rate(minio_queue_processed_total[10m]) == 0 and minio_queue_depth > 0
    for: 5m
    labels:
      severity: critical
    annotations:
      summary: "Queue processing stalled"
```

## Queue Management CLI

```python
# minio/management/commands/queue_status.py
from django.core.management.base import BaseCommand
from minio.queue_manager import QueueManager, QueueName
import redis

class Command(BaseCommand):
    help = "Show queue status"
    
    def handle(self, *args, **options):
        r = redis.Redis.from_url("redis://localhost:6379")
        qm = QueueManager(r)
        stats = qm.get_queue_stats()
        
        self.stdout.write("\n=== Queue Status ===\n")
        for queue, depth in stats["queues"].items():
            self.stdout.write(f"  {queue}: {depth}")
        self.stdout.write(f"\n  Total pending: {stats['total_pending']}")
        self.stdout.write(f"  Dead letter: {stats['dead_letter']}\n")
```

```bash
# CLI commands
python manage.py queue_status
python manage.py queue_purge --queue jobs:default --confirm
python manage.py queue_requeue_dlq --limit 100
python manage.py queue_pause --queue jobs:high
python manage.py queue_resume --queue jobs:high
```

## Free Tier vs Production

| Aspect | Free Tier | Production |
|---|---|---|
| Queues | 1 (jobs:default) | 4 (critical, high, default, low) |
| Workers | 1 process, in-app | Separate worker pods per queue |
| Max concurrent | 2 jobs | 32 jobs across all queues |
| Retry strategy | Inline retry | Dedicated retry consumer + DLQ |
| Monitoring | Logs only | Prometheus + Grafana |
| Autoscaling | None | HPA on queue depth |
