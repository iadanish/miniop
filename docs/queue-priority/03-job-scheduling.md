# MiniOp Job Scheduling

## Overview

Job scheduling in MiniOp determines when and how video processing jobs execute. Beyond simple FIFO ordering, MiniOp supports scheduled jobs, delayed processing, cron-based batch operations, and intelligent resource-aware scheduling that adapts to system load.

## Job Lifecycle

```
Created → Queued → Scheduled → Processing → Completed
    │         │         │           │
    │         │         │           └──→ Failed → Retry → DLQ
    │         │         │
    │         │         └──→ Waiting (delayed)
    │         │
    │         └──→ Expired (TTL exceeded)
    │
    └──→ Cancelled
```

## Job States

```python
# minio/models/job.py
from enum import Enum
from datetime import datetime
from sqlalchemy import Column, String, Integer, Float, DateTime, JSON, Enum as SQLEnum
from sqlalchemy.orm import declarative_base

Base = declarative_base()

class JobStatus(Enum):
    CREATED = "created"
    QUEUED = "queued"
    SCHEDULED = "scheduled"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"
    RETRYING = "retrying"
    DEAD_LETTER = "dead_letter"
    CANCELLED = "cancelled"
    EXPIRED = "expired"

class Job(Base):
    __tablename__ = "jobs"
    
    id = Column(String, primary_key=True)
    user_id = Column(String, nullable=False, index=True)
    status = Column(SQLEnum(JobStatus), default=JobStatus.CREATED, index=True)
    priority = Column(Integer, default=3)
    queue = Column(String, default="jobs:default")
    
    # Input
    video_url = Column(String, nullable=False)
    video_hash = Column(String, index=True)
    options = Column(JSON, default={})
    
    # Processing
    worker_id = Column(String, nullable=True)
    attempt = Column(Integer, default=0)
    max_attempts = Column(Integer, default=3)
    started_at = Column(DateTime, nullable=True)
    completed_at = Column(DateTime, nullable=True)
    
    # Output
    result = Column(JSON, nullable=True)
    error = Column(String, nullable=True)
    clips = Column(JSON, default=[])
    
    # Scheduling
    scheduled_at = Column(DateTime, nullable=True)
    expires_at = Column(DateTime, nullable=True)
    
    # Timestamps
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    # Resource estimates
    estimated_duration = Column(Integer, nullable=True)  # seconds
    actual_duration = Column(Integer, nullable=True)
    file_size_bytes = Column(Integer, nullable=True)
```

## Job Creation and Scheduling

```python
# minio/services/job_service.py
import uuid
import hashlib
import logging
from datetime import datetime, timedelta
from typing import Optional
from sqlalchemy.orm import Session
from minio.models.job import Job, JobStatus
from minio.queue_manager import PriorityQueueManager
from minio.services.priority import Priority

logger = logging.getLogger("minio.job_service")

class JobService:
    def __init__(self, db: Session, queue_manager: PriorityQueueManager):
        self.db = db
        self.queue_manager = queue_manager
    
    def create_job(
        self,
        user_id: str,
        video_url: str,
        options: dict = None,
        priority: Priority = Priority.DEFAULT,
        schedule_at: Optional[datetime] = None,
        expires_in_hours: int = 24,
    ) -> Job:
        job_id = str(uuid.uuid4())
        video_hash = hashlib.sha256(video_url.encode()).hexdigest()[:16]
        
        # Check for duplicate recent jobs
        existing = self.db.query(Job).filter(
            Job.video_hash == video_hash,
            Job.user_id == user_id,
            Job.status.in_([JobStatus.CREATED, JobStatus.QUEUED, JobStatus.PROCESSING]),
            Job.created_at > datetime.utcnow() - timedelta(hours=1),
        ).first()
        
        if existing:
            raise ValueError(f"Duplicate job {existing.id} already in progress")
        
        job = Job(
            id=job_id,
            user_id=user_id,
            video_url=video_url,
            video_hash=video_hash,
            options=options or {},
            priority=int(priority),
            max_attempts=3 if priority != Priority.LOW else 1,
            expires_at=datetime.utcnow() + timedelta(hours=expires_in_hours),
        )
        
        if schedule_at:
            job.status = JobStatus.SCHEDULED
            job.scheduled_at = schedule_at
        else:
            job.status = JobStatus.QUEUED
        
        self.db.add(job)
        self.db.commit()
        
        # Enqueue
        delay = 0
        if schedule_at:
            delay = max(0, (schedule_at - datetime.utcnow()).total_seconds())
        
        self.queue_manager.enqueue(
            job_id=job_id,
            priority=priority,
            metadata={
                "video_url": video_url,
                "options": options or {},
                "user_id": user_id,
            },
            delay=int(delay),
        )
        
        logger.info(f"Job {job_id} created (priority={priority.name}, delay={delay}s)")
        return job
    
    def cancel_job(self, job_id: str, user_id: str) -> bool:
        job = self.db.query(Job).filter(Job.id == job_id, Job.user_id == user_id).first()
        if not job:
            return False
        
        if job.status in (JobStatus.COMPLETED, JobStatus.CANCELLED):
            return False
        
        job.status = JobStatus.CANCELLED
        self.db.commit()
        
        # Remove from Redis queues
        self._remove_from_queues(job_id)
        
        logger.info(f"Job {job_id} cancelled")
        return True
    
    def get_job(self, job_id: str, user_id: str = None) -> Optional[Job]:
        query = self.db.query(Job).filter(Job.id == job_id)
        if user_id:
            query = query.filter(Job.user_id == user_id)
        return query.first()
    
    def list_jobs(
        self,
        user_id: str,
        status: Optional[JobStatus] = None,
        limit: int = 50,
        offset: int = 0,
    ) -> list:
        query = self.db.query(Job).filter(Job.user_id == user_id)
        if status:
            query = query.filter(Job.status == status)
        return query.order_by(Job.created_at.desc()).offset(offset).limit(limit).all()
    
    def _remove_from_queues(self, job_id: str):
        """Remove job from all Redis queues."""
        from minio.queues import QueueName
        for queue in QueueName:
            self.queue_manager.redis.lrem(queue.value, 0, job_id)
        self.queue_manager.redis.zrem("jobs:scheduled", job_id)
        self.queue_manager.redis.zrem("jobs:retry", job_id)
```

## Scheduled and Batch Jobs

### Cron-Based Batch Processing

```python
# minio/scheduler/batch_processor.py
import logging
from datetime import datetime, timedelta
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from minio.services.job_service import JobService
from minio.services.priority import Priority

logger = logging.getLogger("minio.batch_processor")

class BatchScheduler:
    def __init__(self, job_service: JobService):
        self.job_service = job_service
        self.scheduler = BackgroundScheduler()
    
    def start(self):
        # Nightly batch processing for free tier (low priority, off-peak)
        self.scheduler.add_job(
            self.process_nightly_batch,
            CronTrigger(hour=2, minute=0),  # 2 AM UTC
            id="nightly_batch",
            name="Nightly batch processing",
        )
        
        # Cleanup expired jobs every hour
        self.scheduler.add_job(
            self.cleanup_expired_jobs,
            CronTrigger(minute=0),
            id="cleanup_expired",
            name="Cleanup expired jobs",
        )
        
        # Requeue stale jobs every 5 minutes
        self.scheduler.add_job(
            self.requeue_stale_jobs,
            CronTrigger(minute="*/5"),
            id="requeue_stale",
            name="Requeue stale jobs",
        )
        
        # Generate daily metrics
        self.scheduler.add_job(
            self.generate_daily_metrics,
            CronTrigger(hour=0, minute=30),
            id="daily_metrics",
            name="Daily metrics generation",
        )
        
        self.scheduler.start()
        logger.info("Batch scheduler started")
    
    def process_nightly_batch(self):
        """Process batch jobs submitted during the day."""
        logger.info("Starting nightly batch processing")
        
        from minio.models.job import Job, JobStatus
        batch_jobs = self.job_service.db.query(Job).filter(
            Job.status == JobStatus.CREATED,
            Job.options["batch"].as_boolean() == True,
            Job.created_at < datetime.utcnow() - timedelta(hours=1),
        ).all()
        
        for job in batch_jobs:
            self.job_service.create_job(
                user_id=job.user_id,
                video_url=job.video_url,
                options=job.options,
                priority=Priority.LOW,
            )
        
        logger.info(f"Queued {len(batch_jobs)} batch jobs")
    
    def cleanup_expired_jobs(self):
        """Mark expired jobs and clean up resources."""
        from minio.models.job import Job, JobStatus
        
        expired = self.job_service.db.query(Job).filter(
            Job.expires_at < datetime.utcnow(),
            Job.status.in_([JobStatus.QUEUED, JobStatus.SCHEDULED, JobStatus.CREATED]),
        ).all()
        
        for job in expired:
            job.status = JobStatus.EXPIRED
            self.job_service._remove_from_queues(job.id)
        
        self.job_service.db.commit()
        logger.info(f"Expired {len(expired)} jobs")
    
    def requeue_stale_jobs(self):
        """Requeue jobs stuck in processing state."""
        from minio.models.job import Job, JobStatus
        
        stale_threshold = datetime.utcnow() - timedelta(minutes=30)
        stale_jobs = self.job_service.db.query(Job).filter(
            Job.status == JobStatus.PROCESSING,
            Job.started_at < stale_threshold,
        ).all()
        
        for job in stale_jobs:
            if job.attempt < job.max_attempts:
                job.status = JobStatus.RETRYING
                job.attempt += 1
                self.job_service.queue_manager.enqueue(
                    job_id=job.id,
                    priority=Priority(job.priority),
                    metadata={"video_url": job.video_url, "options": job.options},
                )
            else:
                job.status = JobStatus.DEAD_LETTER
        
        self.job_service.db.commit()
        if stale_jobs:
            logger.warning(f"Requeued {len(stale_jobs)} stale jobs")
    
    def generate_daily_metrics(self):
        """Generate daily processing metrics."""
        from minio.models.job import Job, JobStatus
        from sqlalchemy import func
        
        yesterday = datetime.utcnow() - timedelta(days=1)
        
        stats = self.job_service.db.query(
            Job.status,
            func.count(Job.id),
            func.avg(Job.actual_duration),
        ).filter(
            Job.created_at >= yesterday,
        ).group_by(Job.status).all()
        
        metrics = {status.value: {"count": 0, "avg_duration": 0} for status in JobStatus}
        for status, count, avg_dur in stats:
            metrics[status.value] = {"count": count, "avg_duration": avg_dur or 0}
        
        logger.info(f"Daily metrics: {metrics}")
        return metrics
```

## Resource-Aware Scheduling

```python
# minio/scheduler/resource_aware.py
import psutil
import redis
import logging
from minio.queue_manager import PriorityQueueManager
from minio.queues import QueueName

logger = logging.getLogger("minio.resource_scheduler")

class ResourceAwareScheduler:
    """Adjusts scheduling based on system resource availability."""
    
    def __init__(self, redis_client: redis.Redis, queue_manager: PriorityQueueManager):
        self.redis = redis_client
        self.queue_manager = queue_manager
    
    def can_accept_job(self, queue: QueueName) -> bool:
        """Check if system has capacity to accept more jobs."""
        # Check CPU
        cpu_percent = psutil.cpu_percent(interval=1)
        if cpu_percent > 90:
            logger.warning(f"CPU at {cpu_percent}%, rejecting new jobs")
            return queue == QueueName.CRITICAL
        
        # Check memory
        memory = psutil.virtual_memory()
        if memory.percent > 85:
            logger.warning(f"Memory at {memory.percent}%, rejecting new jobs")
            return queue in (QueueName.CRITICAL, QueueName.HIGH)
        
        # Check disk I/O
        disk_io = psutil.disk_io_counters()
        busy_percent = self._calculate_disk_busy()
        if busy_percent > 80:
            logger.warning(f"Disk I/O at {busy_percent}%, throttling")
            return queue in (QueueName.CRITICAL, QueueName.HIGH)
        
        # Check queue depth
        depth = self.queue_manager.get_queue_depth(queue)
        max_depth = {
            QueueName.CRITICAL: 100,
            QueueName.HIGH: 200,
            QueueName.DEFAULT: 500,
            QueueName.LOW: 1000,
        }
        if depth >= max_depth.get(queue, 500):
            logger.warning(f"Queue {queue.value} at capacity ({depth})")
            return queue == QueueName.CRITICAL
        
        return True
    
    def get_max_concurrent(self, queue: QueueName) -> int:
        """Calculate max concurrent jobs based on resources."""
        cpu_count = psutil.cpu_count()
        memory_gb = psutil.virtual_memory().total / (1024**3)
        
        # Base: 2 jobs per CPU core
        base = cpu_count * 2
        
        # Adjust for memory (each job needs ~2GB)
        memory_limit = int(memory_gb / 2)
        
        base = min(base, memory_limit)
        
        # Allocate by priority
        allocations = {
            QueueName.CRITICAL: int(base * 0.3),
            QueueName.HIGH: int(base * 0.3),
            QueueName.DEFAULT: int(base * 0.25),
            QueueName.LOW: int(base * 0.15),
        }
        
        return max(1, allocations.get(queue, 2))
    
    def _calculate_disk_busy(self) -> float:
        """Estimate disk busy percentage."""
        import time
        io1 = psutil.disk_io_counters()
        time.sleep(0.1)
        io2 = psutil.disk_io_counters()
        
        read_bytes = io2.read_bytes - io1.read_bytes
        write_bytes = io2.write_bytes - io1.write_bytes
        
        # Rough estimate: 100MB/s = 100% busy
        busy = (read_bytes + write_bytes) / (100 * 1024 * 1024) * 100
        return min(100, busy)
```

## Job Deduplication

```python
# minio/services/deduplication.py
import hashlib
import redis
import logging
from datetime import timedelta

logger = logging.getLogger("minio.deduplication")

class JobDeduplicator:
    """Prevents duplicate jobs from being processed."""
    
    DEDUP_WINDOW = 3600  # 1 hour
    
    def __init__(self, redis_client: redis.Redis):
        self.redis = redis_client
    
    def is_duplicate(self, user_id: str, video_url: str, options: dict = None) -> bool:
        dedup_key = self._make_key(user_id, video_url, options)
        return self.redis.exists(dedup_key)
    
    def register(self, user_id: str, video_url: str, options: dict = None, job_id: str = None):
        dedup_key = self._make_key(user_id, video_url, options)
        self.redis.setex(dedup_key, self.DEDUP_WINDOW, job_id or "1")
    
    def _make_key(self, user_id: str, video_url: str, options: dict = None) -> str:
        content = f"{user_id}:{video_url}:{sorted((options or {}).items())}"
        hash_val = hashlib.sha256(content.encode()).hexdigest()[:16]
        return f"dedup:{hash_val}"
```

## Scheduling API

```python
# minio/api/routes/scheduling.py
from fastapi import APIRouter, Depends, HTTPException
from datetime import datetime
from pydantic import BaseModel
from typing import Optional
from minio.services.job_service import JobService
from minio.services.priority import Priority
from minio.api.dependencies import get_current_user, get_job_service

router = APIRouter()

class ScheduleJobRequest(BaseModel):
    video_url: str
    options: dict = None
    schedule_at: Optional[datetime] = None
    priority: Optional[str] = "default"
    expires_in_hours: int = 24

@router.post("/api/v1/jobs/schedule")
async def schedule_job(
    request: ScheduleJobRequest,
    user = Depends(get_current_user),
    job_service: JobService = Depends(get_job_service),
):
    priority_map = {
        "critical": Priority.CRITICAL,
        "high": Priority.HIGH,
        "default": Priority.DEFAULT,
        "low": Priority.LOW,
    }
    priority = priority_map.get(request.priority, Priority.DEFAULT)
    
    # Only enterprise can use critical priority
    if priority == Priority.CRITICAL and not user.is_enterprise:
        raise HTTPException(status_code=403, detail="Critical priority requires enterprise plan")
    
    try:
        job = job_service.create_job(
            user_id=user.id,
            video_url=request.video_url,
            options=request.options,
            priority=priority,
            schedule_at=request.schedule_at,
            expires_in_hours=request.expires_in_hours,
        )
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    
    return {
        "id": job.id,
        "status": job.status.value,
        "priority": priority.name,
        "scheduled_at": job.scheduled_at.isoformat() if job.scheduled_at else None,
        "expires_at": job.expires_at.isoformat() if job.expires_at else None,
    }

@router.get("/api/v1/jobs/{job_id}/schedule")
async def get_schedule_info(
    job_id: str,
    user = Depends(get_current_user),
    job_service: JobService = Depends(get_job_service),
):
    job = job_service.get_job(job_id, user.id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    
    return {
        "id": job.id,
        "status": job.status.value,
        "scheduled_at": job.scheduled_at.isoformat() if job.scheduled_at else None,
        "started_at": job.started_at.isoformat() if job.started_at else None,
        "completed_at": job.completed_at.isoformat() if job.completed_at else None,
        "expires_at": job.expires_at.isoformat() if job.expires_at else None,
        "attempt": job.attempt,
        "max_attempts": job.max_attempts,
    }
```

## Free Tier vs Production

| Feature | Free Tier | Production |
|---|---|---|
| Scheduling | Immediate only | Delayed + cron |
| Max job duration | 10 min | 30 min |
| Job expiry | 24 hours | 7 days |
| Deduplication | Basic | Full with hash matching |
| Batch processing | Manual | Nightly cron |
| Resource awareness | CPU only | CPU + memory + disk + queue depth |
| Max concurrent | 2 | 32 (scaled by priority) |
