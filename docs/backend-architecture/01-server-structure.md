# Server Structure — MiniOp Video Clipping Platform

## Architecture Overview

MiniOp's backend is a Go monolith deployed as a set of independently scalable services. The monolith contains all business logic in a single binary but is organized into internal packages that mirror bounded contexts. This avoids the complexity of microservices while keeping the codebase modular enough to extract services later if needed.

The server binary is built once and deployed to three roles via configuration:

- **API server**: Handles HTTP requests, authentication, rate limiting
- **Worker**: Processes video jobs from the queue (transcription, scene detection, clipping)
- **Scheduler**: Runs cron jobs (cleanup, quota resets, webhook retries)

## Directory Structure

```
cmd/
  server/main.go          # API server entrypoint
  worker/main.go          # Worker entrypoint
  scheduler/main.go       # Scheduler entrypoint
internal/
  clip/
    handler.go            # HTTP handlers for clip endpoints
    service.go            # Business logic
    repository.go         # Database access
    model.go              # Domain models
  project/
    handler.go
    service.go
    repository.go
    model.go
  auth/
    middleware.go          # JWT validation, scope checking
    token.go              # Token generation and validation
  queue/
    producer.go           # Job enqueue logic
    consumer.go           # Job dequeue and processing
  storage/
    s3.go                 # Object storage client
    presign.go            # Presigned URL generation
  transcoder/
    ffmpeg.go             # FFmpeg wrapper
    whisper.go            # Whisper transcription client
  config/
    config.go             # Configuration loading
pkg/
  httputil/
    response.go           # JSON response helpers
    error.go              # RFC 7807 error responses
  ratelimit/
    sliding_window.go     # Redis-based rate limiter
  logger/
    logger.go             # Structured logging setup
```

## Entrypoint — API Server

```go
// cmd/server/main.go
package main

import (
    "context"
    "log/slog"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"

    "github.com/go-chi/chi/v5"
    "github.com/minio/minio/internal/auth"
    "github.com/minio/minio/internal/clip"
    "github.com/minio/minio/internal/config"
    "github.com/minio/minio/internal/project"
    "github.com/minio/minio/pkg/ratelimit"
)

func main() {
    cfg := config.MustLoad()
    logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: cfg.LogLevel}))
    slog.SetDefault(logger)

    db := config.MustConnectDB(cfg)
    rdb := config.MustConnectRedis(cfg)
    storage := config.MustConnectS3(cfg)

    // Middleware chain
    r := chi.NewRouter()
    r.Use(middleware.RequestID)
    r.Use(middleware.RealIP)
    r.Use(middleware.Logger(logger))
    r.Use(middleware.Recoverer)
    r.Use(middleware.SecurityHeaders)
    r.Use(middleware.CORS(cfg.AllowedOrigins))

    // Rate limiting
    limiter := ratelimit.New(rdb)

    // Auth
    authMW := auth.Middleware(cfg.JWKSUrl)

    // Routes
    r.Route("/v1", func(r chi.Router) {
        r.Use(authMW)
        r.Use(limiter.Middleware)

        clipHandler := clip.NewHandler(db, storage)
        projectHandler := project.NewHandler(db)

        r.Route("/clips", func(r chi.Router) {
            r.Get("/", clipHandler.List)
            r.Get("/{id}", clipHandler.Get)
        })

        r.Route("/projects", func(r chi.Router) {
            r.Post("/", projectHandler.Create)
            r.Get("/", projectHandler.List)
            r.Route("/{projectID}/clips", func(r chi.Router) {
                r.Post("/", clipHandler.Create)
            })
        })

        r.Route("/jobs", func(r chi.Router) {
            r.Get("/{id}", clipHandler.GetJob)
        })
    })

    // Health checks
    r.Get("/healthz", func(w http.ResponseWriter, r *http.Request) {
        w.Write([]byte("ok"))
    })
    r.Get("/readyz", func(w http.ResponseWriter, r *http.Request) {
        if err := db.Ping(r.Context()); err != nil {
            w.WriteHeader(503)
            w.Write([]byte("not ready"))
            return
        }
        w.Write([]byte("ok"))
    })

    // Graceful shutdown
    srv := &http.Server{
        Addr:         ":" + cfg.Port,
        Handler:      r,
        ReadTimeout:  15 * time.Second,
        WriteTimeout: 60 * time.Second,
        IdleTimeout:  120 * time.Second,
    }

    go func() {
        logger.Info("server starting", "port", cfg.Port)
        if err := srv.ListenAndServe(); err != http.ErrServerClosed {
            logger.Error("server failed", "error", err)
            os.Exit(1)
        }
    }()

    quit := make(chan os.Signal, 1)
    signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
    <-quit

    logger.Info("shutting down gracefully")
    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()
    srv.Shutdown(ctx)
}
```

## Entrypoint — Worker

```go
// cmd/worker/main.go
package main

import (
    "context"
    "log/slog"
    "os"
    "os/signal"
    "syscall"

    "github.com/minio/minio/internal/config"
    "github.com/minio/minio/internal/queue"
    "github.com/minio/minio/internal/transcoder"
)

func main() {
    cfg := config.MustLoad()
    logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
    slog.SetDefault(logger)

    db := config.MustConnectDB(cfg)
    storage := config.MustConnectS3(cfg)
    rdb := config.MustConnectRedis(cfg)

    whisper := transcoder.NewWhisperClient(cfg.WhisperURL)
    ffmpeg := transcoder.NewFFmpeg(cfg.FFmpegPath)

    processors := map[string]queue.Processor{
        "transcription":   transcoder.NewTranscriptionProcessor(whisper, storage),
        "scene_detection": transcoder.NewSceneDetectionProcessor(ffmpeg),
        "clip_generation": transcoder.NewClipGenerationProcessor(ffmpeg, storage, db),
        "export":          transcoder.NewExportProcessor(ffmpeg, storage),
    }

    consumer := queue.NewConsumer(rdb, cfg.QueueName, processors, queue.ConsumerConfig{
        Concurrency:    cfg.WorkerConcurrency,
        MaxRetries:     3,
        RetryBackoff:   []time.Duration{1 * time.Second, 4 * time.Second, 16 * time.Second},
        VisibilityTimeout: 10 * time.Minute,
    })

    ctx, cancel := context.WithCancel(context.Background())
    go func() {
        sig := make(chan os.Signal, 1)
        signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
        <-sig
        logger.Info("shutting down worker")
        cancel()
    }()

    logger.Info("worker starting", "concurrency", cfg.WorkerConcurrency)
    if err := consumer.Run(ctx); err != nil {
        logger.Error("worker failed", "error", err)
        os.Exit(1)
    }
}
```

## Configuration

Configuration is loaded from environment variables with sensible defaults:

```go
// internal/config/config.go
package config

import (
    "log/slog"
    "os"
    "strconv"
    "strings"
)

type Config struct {
    Port              string
    DatabaseURL       string
    RedisURL          string
    S3Endpoint        string
    S3AccessKey       string
    S3SecretKey       string
    JWKSUrl           string
    AllowedOrigins    []string
    WhisperURL        string
    FFmpegPath        string
    WorkerConcurrency int
    QueueName         string
    LogLevel          slog.Level
}

func MustLoad() *Config {
    return &Config{
        Port:              envOrDefault("PORT", "8080"),
        DatabaseURL:       mustEnv("DATABASE_URL"),
        RedisURL:          mustEnv("REDIS_URL"),
        S3Endpoint:        mustEnv("S3_ENDPOINT"),
        S3AccessKey:       mustEnv("S3_ACCESS_KEY"),
        S3SecretKey:       mustEnv("S3_SECRET_KEY"),
        JWKSUrl:           mustEnv("JWKS_URL"),
        AllowedOrigins:    strings.Split(envOrDefault("ALLOWED_ORIGINS", "https://app.minio.dev"), ","),
        WhisperURL:        envOrDefault("WHISPER_URL", "http://whisper:9000"),
        FFmpegPath:        envOrDefault("FFMPEG_PATH", "/usr/bin/ffmpeg"),
        WorkerConcurrency: envIntOrDefault("WORKER_CONCURRENCY", 4),
        QueueName:         envOrDefault("QUEUE_NAME", "minio:jobs"),
    }
}

func envOrDefault(key, fallback string) string {
    if v := os.Getenv(key); v != "" {
        return v
    }
    return fallback
}

func mustEnv(key string) string {
    v := os.Getenv(key)
    if v == "" {
        panic("missing required env: " + key)
    }
    return v
}

func envIntOrDefault(key string, fallback int) int {
    v := os.Getenv(key)
    if v == "" {
        return fallback
    }
    n, _ := strconv.Atoi(v)
    return n
}
```

## Free-Tier vs Production Deployment

**Free tier** runs on a single EC2 instance (t3.large) with all three binaries:

```yaml
# docker-compose.yml (free tier)
services:
  api:
    image: minio/server:latest
    command: ["server"]
    ports: ["8080:8080"]
    env_file: .env

  worker:
    image: minio/server:latest
    command: ["worker"]
    env_file: .env
    deploy:
      replicas: 1

  scheduler:
    image: minio/server:latest
    command: ["scheduler"]
    env_file: .env

  postgres:
    image: postgres:16
    volumes: ["pgdata:/var/lib/postgresql/data"]

  redis:
    image: redis:7-alpine
```

**Production** runs on Kubernetes with separate deployments:

```yaml
# k8s/api-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: minio-api
spec:
  replicas: 3
  selector:
    matchLabels:
      app: minio-api
  template:
    spec:
      containers:
        - name: api
          image: minio/server:latest
          command: ["server"]
          ports:
            - containerPort: 8080
          resources:
            requests:
              cpu: "500m"
              memory: "512Mi"
            limits:
              cpu: "2"
              memory: "2Gi"
          readinessProbe:
            httpGet:
              path: /readyz
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /healthz
              port: 8080
            initialDelaySeconds: 15
            periodSeconds: 20
```

## Graceful Shutdown

All three binaries handle SIGINT/SIGTERM gracefully:

- **API server**: Stops accepting new connections, waits for in-flight requests (30s timeout)
- **Worker**: Finishes current job, then exits. Job visibility timeout ensures uncompleted jobs re-enter the queue
- **Scheduler**: Completes current cron tick, then exits

## Monitoring Hooks

Every binary exposes Prometheus metrics at `/metrics`:

```go
import "github.com/prometheus/client_golang/prometheus"

var (
    requestsTotal = prometheus.NewCounterVec(
        prometheus.CounterOpts{Name: "http_requests_total", Help: "Total HTTP requests"},
        []string{"method", "path", "status"},
    )
    activeWorkers = prometheus.NewGauge(
        prometheus.GaugeOpts{Name: "worker_active_jobs", Help: "Currently processing jobs"},
    )
)
```

Dashboards track: request latency p95, error rate, queue depth, worker utilization, and database connection pool saturation.
