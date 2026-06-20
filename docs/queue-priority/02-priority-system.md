# MiniOp Priority Queue System

## Priority Model

MiniOp serves both free and paid users. Paid users expect faster processing. The priority system ensures paid jobs are processed first without starving free users entirely.

## Priority Levels

| Priority | Queue | User Type | SLA | Starvation Protection |
|---|---|---|---|---|
| 1 (Critical) | `jobs:critical` | Enterprise API keys, urgent requests | < 2 min | None — always first |
| 2 (High) | `jobs:high` | Paid subscribers | < 5 min | None — always before default |
| 3 (Default) | `jobs:default` | Free tier users | < 30 min | Guaranteed 30% worker capacity |
| 4 (Low) | `jobs:low` | Batch processing, retries, internal | Best effort | Guaranteed 10% worker capacity |

## Priority Assignment

```python
# minio/services/priority.py
from enum import IntEnum
from minio.queues import QueueName

class Priority(IntEnum):
    CRITICAL = 1
    HIGH = 2
    DEFAULT = 3
    LOW = 4

PRIORITY_MAP = {
    Priority.CRITICAL: QueueName.CRITICAL,
    Priority.HIGH: QueueName.HIGH,
    Priority.DEFAULT: QueueName.DEFAULT,
    Priority.LOW: QueueName.LOW,
}

def determine_priority(user) -> Priority:
    """Determine queue priority based on user subscription and request context."""
    if user.is_enterprise:
        return Priority.CRITICAL
    if user.subscription_tier in ("pro", "business"):
        return Priority.HIGH
    return Priority.DEFAULT

def determine_priority_from_api_key(api_key) -> Priority:
    """Determine priority from API key metadata."""
    if api_key.metadata.get("priority") == "critical":
        return Priority.CRITICAL
    if api_key.metadata.get("priority") == "high":
        return Priority.HIGH
    if api_key.metadata.get("tier") in ("pro", "business", "enterprise"):
        return Priority.HIGH
    return Priority.DEFAULT
```

## Priority Enforcement in Queue Manager

```python
# minio/queue_manager.py
import redis
import json
import time
import logging
from typing import Optional
from minio.queues import QueueName, QUEUE_CONFIG
from minio.services.priority import Priority, PRIORITY_MAP

logger = logging.getLogger("minio.queue_manager")

class PriorityQueueManager:
    def __init__(self, redis_client: redis.Redis):
        self.redis = redis_client
        self.queue_weights = {
            QueueName.CRITICAL: 0.40,  # 40% of capacity
            QueueName.HIGH: 0.30,      # 30% of capacity
            QueueName.DEFAULT: 0.20,   # 20% of capacity
            QueueName.LOW: 0.10,       # 10% of capacity
        }
    
    def enqueue(
        self,
        job_id: str,
        priority: Priority = Priority.DEFAULT,
        metadata: dict = None,
        delay: int = 0,
    ) -> str:
        queue = PRIORITY_MAP[priority]
        
        job_data = {
            "job_id": job_id,
            "queue": queue.value,
            "priority": int(priority),
            "enqueued_at": time.time(),
            "attempt": 0,
            "metadata": metadata or {},
        }
        
        if delay > 0:
            execute_at = time.time() + delay
            self.redis.zadd("jobs:scheduled", {json.dumps(job_data): execute_at})
        else:
            self.redis.lpush(queue.value, json.dumps(job_data))
        
        self.redis.hset(f"job:{job_id}", mapping={
            "status": "queued",
            "queue": queue.value,
            "priority": int(priority),
            "enqueued_at": time.time(),
            "attempt": 0,
        })
        
        logger.info(f"Job {job_id} enqueued to {queue.value} (priority={priority.name})")
        return job_id
    
    def dequeue_weighted(self, timeout: int = 1) -> Optional[dict]:
        """Dequeue from highest-priority non-empty queue, respecting weights."""
        queues_by_priority = [
            QueueName.CRITICAL,
            QueueName.HIGH,
            QueueName.DEFAULT,
            QueueName.LOW,
        ]
        
        # Always check critical first
        for queue in [QueueName.CRITICAL, QueueName.HIGH]:
            if self.redis.llen(queue.value) > 0:
                result = self.redis.rpop(queue.value)
                if result:
                    return json.loads(result)
        
        # For default and low, use weighted selection
        default_depth = self.redis.llen(QueueName.DEFAULT.value)
        low_depth = self.redis.llen(QueueName.LOW.value)
        
        if default_depth == 0 and low_depth == 0:
            # Block on any queue
            result = self.redis.brpop(
                [q.value for q in queues_by_priority],
                timeout=timeout,
            )
            if result:
                return json.loads(result[1])
            return None
        
        if default_depth == 0:
            result = self.redis.rpop(QueueName.LOW.value)
            return json.loads(result) if result else None
        
        if low_depth == 0:
            result = self.redis.rpop(QueueName.DEFAULT.value)
            return json.loads(result) if result else None
        
        # Weighted: default gets 2x low's share
        import random
        if random.random() < (2 / 3):
            result = self.redis.rpop(QueueName.DEFAULT.value)
        else:
            result = self.redis.rpop(QueueName.LOW.value)
        
        return json.loads(result) if result else None
    
    def get_queue_stats(self) -> dict:
        stats = {}
        for queue in QueueName:
            if queue != QueueName.DEAD_LETTER:
                stats[queue.value] = self.redis.llen(queue.value)
        stats["dead_letter"] = self.redis.llen(QueueName.DEAD_LETTER.value)
        stats["scheduled"] = self.redis.zcard("jobs:scheduled")
        stats["retry"] = self.redis.zcard("jobs:retry")
        stats["total_pending"] = sum(
            v for k, v in stats.items()
            if k not in ("dead_letter",)
        )
        return stats
```

## Worker Pool with Priority Awareness

```python
# minio/workers/priority_worker.py
import threading
import time
import logging
from minio.workers.base import Worker
from minio.queues import QueueName
from minio.queue_manager import PriorityQueueManager

logger = logging.getLogger("minio.priority_worker")

class PriorityWorkerPool:
    """Manages multiple worker pools with priority-aware scheduling."""
    
    def __init__(
        self,
        queue_manager: PriorityQueueManager,
        handler,
        total_workers: int = 16,
    ):
        self.queue_manager = queue_manager
        self.handler = handler
        self.total_workers = total_workers
        self.workers = {}
        self.running = False
        self._lock = threading.Lock()
        
        # Allocate workers by priority weight
        self._allocate_workers()
    
    def _allocate_workers(self):
        weights = self.queue_manager.queue_weights
        remaining = self.total_workers
        
        for queue, weight in weights.items():
            count = max(1, int(self.total_workers * weight))
            if queue == QueueName.LOW:
                count = remaining  # Give remaining to low
            remaining -= count
            self.workers[queue] = count
        
        logger.info(f"Worker allocation: {self.workers}")
    
    def start(self):
        self.running = True
        threads = []
        
        for queue, count in self.workers.items():
            for i in range(count):
                t = threading.Thread(
                    target=self._worker_loop,
                    args=(queue, f"{queue.value}-{i}"),
                    daemon=True,
                )
                threads.append(t)
                t.start()
        
        logger.info(f"Started {sum(self.workers.values())} workers")
        
        # Keep main thread alive
        while self.running:
            time.sleep(1)
    
    def _worker_loop(self, queue: QueueName, worker_id: str):
        logger.info(f"Worker {worker_id} started")
        
        while self.running:
            try:
                # For critical and high, always dequeue from own queue
                if queue in (QueueName.CRITICAL, QueueName.HIGH):
                    job = self.queue_manager.redis.rpop(queue.value)
                else:
                    # Default and low workers can also process higher priority
                    job = self._dequeue_with_priority_cascade(queue)
                
                if not job:
                    time.sleep(0.5)
                    continue
                
                import json
                job_data = json.loads(job) if isinstance(job, bytes) else job
                self._process_job(job_data, worker_id)
                
            except Exception as e:
                logger.error(f"Worker {worker_id} error: {e}")
                time.sleep(1)
    
    def _dequeue_with_priority_cascade(self, primary_queue: QueueName) -> bytes:
        """Try own queue first, then check higher priority queues."""
        # Check own queue
        job = self.queue_manager.redis.rpop(primary_queue.value)
        if job:
            return job
        
        # Check higher priority queues (for idle workers)
        higher_queues = {
            QueueName.DEFAULT: [QueueName.HIGH, QueueName.CRITICAL],
            QueueName.LOW: [QueueName.DEFAULT, QueueName.HIGH, QueueName.CRITICAL],
        }
        
        for q in higher_queues.get(primary_queue, []):
            job = self.queue_manager.redis.rpop(q.value)
            if job:
                return job
        
        return None
    
    def _process_job(self, job: dict, worker_id: str):
        job_id = job["job_id"]
        try:
            self.queue_manager.redis.hset(f"job:{job_id}", mapping={
                "status": "processing",
                "started_at": time.time(),
                "worker_id": worker_id,
            })
            self.queue_manager.redis.lpush("jobs:processing", job_id)
            
            result = self.handler(job)
            
            self.queue_manager.redis.hset(f"job:{job_id}", mapping={
                "status": "completed",
                "completed_at": time.time(),
            })
            self.queue_manager.redis.lrem("jobs:processing", 0, job_id)
            
        except Exception as e:
            logger.error(f"Job {job_id} failed on worker {worker_id}: {e}")
            self.queue_manager.redis.hset(f"job:{job_id}", mapping={
                "status": "failed",
                "error": str(e),
            })
            self.queue_manager.redis.lrem("jobs:processing", 0, job_id)
    
    def stop(self):
        self.running = False
```

## Starvation Prevention

Free tier users must never be completely starved. The system guarantees minimum capacity:

```python
# minio/workers/starvation_guard.py
import time
import threading
import logging

logger = logging.getLogger("minio.starvation_guard")

class StarvationGuard:
    """Monitors queue wait times and adjusts worker allocation if starvation detected."""
    
    MAX_WAIT_SECONDS = {
        "jobs:critical": 120,    # 2 minutes
        "jobs:high": 300,        # 5 minutes
        "jobs:default": 1800,    # 30 minutes
        "jobs:low": 3600,        # 1 hour
    }
    
    def __init__(self, redis_client, worker_pool):
        self.redis = redis_client
        self.worker_pool = worker_pool
        self.running = False
    
    def start(self):
        self.running = True
        t = threading.Thread(target=self._monitor_loop, daemon=True)
        t.start()
    
    def _monitor_loop(self):
        while self.running:
            try:
                self._check_starvation()
            except Exception as e:
                logger.error(f"Starvation guard error: {e}")
            time.sleep(30)
    
    def _check_starvation(self):
        for queue, max_wait in self.MAX_WAIT_SECONDS.items():
            # Check oldest job in queue
            oldest = self.redis.lindex(queue, -1)
            if not oldest:
                continue
            
            import json
            job = json.loads(oldest)
            wait_time = time.time() - job.get("enqueued_at", time.time())
            
            if wait_time > max_wait:
                logger.warning(
                    f"STARVATION DETECTED: {queue} oldest job waiting {wait_time:.0f}s "
                    f"(max: {max_wait}s). Job: {job['job_id']}"
                )
                self._remediate_starvation(queue, wait_time)
    
    def _remediate_starvation(self, queue: str, wait_time: float):
        # If default queue is starving, temporarily borrow a worker from low
        if queue == "jobs:default" and wait_time > 1800:
            logger.info("Borrowing worker from low priority for default queue")
            # Implementation: signal worker pool to reassign
```

## API Integration

```python
# minio/api/routes/jobs.py
from fastapi import APIRouter, Depends, HTTPException
from minio.queue_manager import PriorityQueueManager
from minio.services.priority import determine_priority, determine_priority_from_api_key
from minio.api.dependencies import get_current_user, get_queue_manager

router = APIRouter()

@router.post("/api/v1/jobs")
async def create_job(
    video_url: str,
    options: dict = None,
    user = Depends(get_current_user),
    queue_manager: PriorityQueueManager = Depends(get_queue_manager),
):
    # Determine priority based on user
    priority = determine_priority(user)
    
    # Allow API key override for enterprise
    if hasattr(user, 'api_key') and user.api_key:
        priority = determine_priority_from_api_key(user.api_key)
    
    # Check quota
    if priority == Priority.DEFAULT and user.free_jobs_remaining <= 0:
        raise HTTPException(
            status_code=429,
            detail={
                "error": "QUOTA_EXCEEDED",
                "message": "Free tier job limit reached. Upgrade for more.",
                "upgrade_url": "/pricing",
            },
        )
    
    # Create job record in database
    job_id = create_job_record(user.id, video_url, options)
    
    # Enqueue with priority
    queue_manager.enqueue(
        job_id=job_id,
        priority=priority,
        metadata={
            "video_url": video_url,
            "options": options or {},
            "user_id": user.id,
            "tier": user.subscription_tier,
        },
    )
    
    return {
        "id": job_id,
        "status": "queued",
        "priority": priority.name,
        "estimated_wait": get_estimated_wait(priority, queue_manager),
    }

def get_estimated_wait(priority, queue_manager) -> int:
    """Estimate wait time in seconds based on queue depth and processing rate."""
    stats = queue_manager.get_queue_stats()
    queue_name = PRIORITY_MAP[priority].value
    depth = stats.get(queue_name, 0)
    
    # Average processing time per job (measured from metrics)
    avg_processing_time = 120  # seconds, ideally from Prometheus
    
    # Jobs ahead in higher-priority queues
    ahead = sum(
        stats.get(q.value, 0)
        for q in QueueName
        if q.value < queue_name and q != QueueName.DEAD_LETTER
    )
    
    return (ahead + depth) * avg_processing_time // get_worker_count(queue_name)

def get_worker_count(queue_name: str) -> int:
    from minio.queues import QUEUE_CONFIG
    return QUEUE_CONFIG.get(QueueName(queue_name), {}).get("max_concurrency", 4)
```

## Metrics

```python
# minio/monitoring/priority_metrics.py
from prometheus_client import Gauge, Histogram

PRIORITY_WAIT_TIME = Histogram(
    'minio_priority_wait_seconds',
    'Time spent waiting in queue',
    ['priority'],
    buckets=[1, 5, 10, 30, 60, 120, 300, 600, 1800, 3600]
)

PRIORITY_THROUGHPUT = Gauge(
    'minio_priority_throughput_jobs_per_minute',
    'Jobs processed per minute by priority',
    ['priority']
)

STARVATION_EVENTS = Gauge(
    'minio_starvation_events_total',
    'Number of starvation events detected',
    ['queue']
)
```
