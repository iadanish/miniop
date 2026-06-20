# Service Layer — MiniOp Video Clipping Platform

## Purpose of the Service Layer

The service layer contains all business logic. Handlers parse HTTP requests and format responses; repositories execute database queries; services orchestrate the domain operations between them. This separation means the same service function can be called from an HTTP handler, a CLI command, or a background worker without change.

Every service follows the same pattern: receive a validated request, enforce business rules, call repositories and external services, return a domain model or error.

## Service Interface Pattern

Each service is defined as an interface in the domain package and implemented in the service package. This enables testing with mocks and swapping implementations:

```go
// internal/clip/service.go
package clip

import "context"

type Service interface {
    CreateClipSet(ctx context.Context, req CreateClipSetRequest) (*ClipSet, error)
    GetClip(ctx context.Context, clipID string) (*Clip, error)
    ListClips(ctx context.Context, userID string, opts ListOptions) (*ClipList, error)
    DeleteClip(ctx context.Context, clipID string) error
    GetJobStatus(ctx context.Context, jobID string) (*Job, error)
}

type CreateClipSetRequest struct {
    SourceURL     string
    Strategy      string
    TargetDuration int
    MaxClips      int
    AspectRatio   string
    Languages     []string
    CaptionStyle  string
    WebhookURL    string
    UserID        string
    OrgID         string
    Tier          string
}

type ListOptions struct {
    Cursor string
    Limit  int
    Status string
}
```

## Clip Service Implementation

The clip service is the core of MiniOp. It validates the request, checks quotas, stores metadata, and enqueues processing jobs:

```go
// internal/clip/service_impl.go
package clip

import (
    "context"
    "fmt"
    "time"

    "github.com/minio/minio/internal/queue"
    "github.com/minio/minio/internal/storage"
)

type clipService struct {
    repo       Repository
    jobRepo    JobRepository
    quota      QuotaChecker
    storage    storage.Client
    queue      queue.Producer
    webhookSvc WebhookService
}

func NewService(repo Repository, jobRepo JobRepository, quota QuotaChecker, storage storage.Client, queue queue.Producer, webhookSvc WebhookService) Service {
    return &clipService{
        repo:       repo,
        jobRepo:    jobRepo,
        quota:      quota,
        storage:    storage,
        queue:      queue,
        webhookSvc: webhookSvc,
    }
}

func (s *clipService) CreateClipSet(ctx context.Context, req CreateClipSetRequest) (*ClipSet, error) {
    // 1. Check quota
    allowed, remaining, err := s.quota.Check(ctx, req.UserID, req.Tier)
    if err != nil {
        return nil, fmt.Errorf("quota check failed: %w", err)
    }
    if !allowed {
        return nil, ErrQuotaExceeded{Remaining: remaining, Tier: req.Tier}
    }

    // 2. Validate source URL exists in storage
    meta, err := s.storage.HeadObject(ctx, "uploads", extractKey(req.SourceURL))
    if err != nil {
        return nil, ErrSourceNotFound{URL: req.SourceURL}
    }

    // 3. Check duration limits per tier
    duration := meta.Duration
    maxDuration := maxDurationForTier(req.Tier)
    if duration > maxDuration {
        return nil, ErrDurationExceeded{Duration: duration, Max: maxDuration}
    }

    // 4. Apply tier-specific defaults
    maxClips := req.MaxClips
    if maxClips > maxClipsForTier(req.Tier) {
        maxClips = maxClipsForTier(req.Tier)
    }

    // 5. Create clip set record
    clipSet := &ClipSet{
        ID:             generateID("clip_set"),
        UserID:         req.UserID,
        OrgID:          req.OrgID,
        SourceURL:      req.SourceURL,
        SourceDuration: duration,
        Strategy:       req.Strategy,
        Options: ClipOptions{
            TargetDuration: req.TargetDuration,
            MaxClips:       maxClips,
            AspectRatio:    req.AspectRatio,
            Languages:      req.Languages,
            CaptionStyle:   req.CaptionStyle,
        },
        Status:    "processing",
        CreatedAt: time.Now(),
    }

    if err := s.repo.CreateClipSet(ctx, clipSet); err != nil {
        return nil, fmt.Errorf("save clip set: %w", err)
    }

    // 6. Enqueue processing jobs
    jobs := []queue.Job{
        {
            Type: "transcription",
            Payload: map[string]interface{}{
                "clip_set_id": clipSet.ID,
                "source_url":  req.SourceURL,
                "languages":   req.Languages,
            },
            Priority: priorityForTier(req.Tier),
        },
        {
            Type: "scene_detection",
            Payload: map[string]interface{}{
                "clip_set_id": clipSet.ID,
                "source_url":  req.SourceURL,
            },
            Priority: priorityForTier(req.Tier),
        },
    }

    for _, job := range jobs {
        if err := s.queue.Enqueue(ctx, job); err != nil {
            // Mark clip set as failed if we can't enqueue
            s.repo.UpdateClipSetStatus(ctx, clipSet.ID, "failed")
            return nil, fmt.Errorf("enqueue job: %w", err)
        }
    }

    // 7. Schedule webhook delivery (if provided)
    if req.WebhookURL != "" {
        s.webhookSvc.Schedule(ctx, clipSet.ID, req.WebhookURL, "clip_set.completed")
    }

    return clipSet, nil
}
```

## Quota Checker

The quota checker is a separate service that queries the billing/usage system:

```go
// internal/clip/quota.go
package clip

type QuotaChecker interface {
    Check(ctx context.Context, userID string, tier string) (allowed bool, remaining int, err error)
}

type quotaChecker struct {
    usageRepo UsageRepository
    limits    map[string]int
}

func NewQuotaChecker(repo UsageRepository) QuotaChecker {
    return &quotaChecker{
        usageRepo: repo,
        limits: map[string]int{
            "free":       50,   // 50 clips/month
            "pro":        500,  // 500 clips/month
            "enterprise": -1,   // unlimited
        },
    }
}

func (q *quotaChecker) Check(ctx context.Context, userID string, tier string) (bool, int, error) {
    limit := q.limits[tier]
    if limit == -1 {
        return true, -1, nil // unlimited
    }

    used, err := q.usageRepo.GetMonthlyUsage(ctx, userID)
    if err != nil {
        return false, 0, err
    }

    remaining := limit - used
    return remaining > 0, remaining, nil
}
```

## Webhook Service

The webhook service manages delivery and retries:

```go
// internal/clip/webhook.go
package clip

import (
    "context"
    "crypto/hmac"
    "crypto/sha256"
    "encoding/hex"
    "time"
)

type WebhookService interface {
    Schedule(ctx context.Context, clipSetID, webhookURL, event string) error
    Deliver(ctx context.Context, deliveryID string) error
}

type webhookService struct {
    repo    WebhookRepository
    client  HTTPClient
    secrets map[string]string // userID -> webhook secret
}

func (w *webhookService) Deliver(ctx context.Context, deliveryID string) error {
    delivery, err := w.repo.GetDelivery(ctx, deliveryID)
    if err != nil {
        return err
    }

    payload := buildWebhookPayload(delivery)
    signature := w.sign(payload, w.secrets[delivery.UserID])

    resp, err := w.client.Post(ctx, delivery.URL, "application/json", payload, map[string]string{
        "X-Minio-Signature": "sha256=" + signature,
        "X-Minio-Event":     delivery.Event,
        "X-Minio-Delivery":  delivery.ID,
    })

    if err != nil || resp.StatusCode >= 400 {
        // Schedule retry with exponential backoff
        backoff := time.Duration(1<<delivery.Attempts) * time.Second
        if backoff > 256*time.Second {
            backoff = 256 * time.Second
        }
        delivery.NextRetry = time.Now().Add(backoff)
        delivery.Attempts++
        if delivery.Attempts > 5 {
            delivery.Status = "failed"
        }
        return w.repo.UpdateDelivery(ctx, delivery)
    }

    delivery.Status = "delivered"
    delivery.DeliveredAt = time.Now()
    return w.repo.UpdateDelivery(ctx, delivery)
}

func (w *webhookService) sign(payload []byte, secret string) string {
    mac := hmac.New(sha256.New, []byte(secret))
    mac.Write(payload)
    return hex.EncodeToString(mac.Sum(nil))
}
```

## Project Service

The project service manages organizational grouping of clips:

```go
// internal/project/service.go
package project

type Service interface {
    Create(ctx context.Context, req CreateRequest) (*Project, error)
    List(ctx context.Context, userID string, opts ListOptions) (*ProjectList, error)
    Get(ctx context.Context, projectID string) (*Project, error)
    Delete(ctx context.Context, projectID string) error
}

type projectService struct {
    repo    Repository
    clipSvc ClipService
}

func (s *projectService) Delete(ctx context.Context, projectID string) error {
    // Verify ownership
    project, err := s.repo.Get(ctx, projectID)
    if err != nil {
        return err
    }
    claims := GetClaims(ctx)
    if project.UserID != claims.UserID {
        return ErrForbidden
    }

    // Delete all clips in the project (cascading)
    if err := s.clipSvc.DeleteByProject(ctx, projectID); err != nil {
        return fmt.Errorf("delete project clips: %w", err)
    }

    return s.repo.Delete(ctx, projectID)
}
```

## Dependency Injection

All services are wired together in the server's main function using constructor injection:

```go
// cmd/server/main.go (excerpt)
func setupServices(db *sql.DB, rdb *redis.Client, s3Client *s3.Client, queue queue.Producer) {
    // Repositories
    clipRepo := clip.NewRepository(db)
    jobRepo := clip.NewJobRepository(db)
    usageRepo := clip.NewUsageRepository(db)
    projectRepo := project.NewRepository(db)

    // Services
    quotaChecker := clip.NewQuotaChecker(usageRepo)
    webhookService := clip.NewWebhookService(clip.NewWebhookRepository(db), &http.Client{}, secrets)
    clipService := clip.NewService(clipRepo, jobRepo, quotaChecker, s3Client, queue, webhookService)
    projectService := project.NewService(projectRepo, clipService)

    // Handlers
    clipHandler := clip.NewHandler(clipService)
    projectHandler := project.NewHandler(projectService)
}
```

No global state, no service locators. Every dependency is explicit in the constructor signature.

## Testing Services

Services are tested with mock repositories:

```go
// internal/clip/service_test.go
package clip_test

func TestCreateClipSet_FreeTierQuotaExceeded(t *testing.T) {
    mockQuota := &MockQuotaChecker{
        CheckFn: func(ctx context.Context, userID, tier string) (bool, int, error) {
            return false, 0, nil // quota exceeded
        },
    }

    svc := clip.NewService(nil, nil, mockQuota, nil, nil, nil)

    _, err := svc.CreateClipSet(context.Background(), clip.CreateClipSetRequest{
        SourceURL: "https://storage.minio.dev/uploads/test.mp4",
        UserID:    "usr_abc",
        Tier:      "free",
    })

    var quotaErr clip.ErrQuotaExceeded
    assert.ErrorAs(t, err, &quotaErr)
    assert.Equal(t, "free", quotaErr.Tier)
}
```

## Error Handling

Services return domain-specific errors that handlers translate to HTTP responses:

```go
// internal/clip/errors.go
package clip

type ErrQuotaExceeded struct {
    Remaining int
    Tier      string
}

func (e ErrQuotaExceeded) Error() string {
    return fmt.Sprintf("quota exceeded for tier %s, %d remaining", e.Tier, e.Remaining)
}

type ErrSourceNotFound struct {
    URL string
}

type ErrDurationExceeded struct {
    Duration float64
    Max      float64
}
```

The handler maps errors to HTTP responses:

```go
func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
    clipSet, err := h.service.CreateClipSet(r.Context(), req)
    if err != nil {
        switch e := err.(type) {
        case clip.ErrQuotaExceeded:
            writeRFC7807(w, 429, "quota-exceeded",
                fmt.Sprintf("Free tier allows %d clips/month", e.Remaining+1))
        case clip.ErrSourceNotFound:
            writeRFC7807(w, 404, "source-not-found", "Video file not found")
        case clip.ErrDurationExceeded:
            writeRFC7807(w, 400, "duration-exceeded",
                fmt.Sprintf("Video exceeds max duration of %.0f seconds", e.Max))
        default:
            writeRFC7807(w, 500, "internal-error", "Something went wrong")
        }
        return
    }

    writeJSON(w, 202, clipSet)
}
```

## Free-Tier vs Paid-Tier Service Behavior

The service layer enforces tier differences through the `Tier` field on every request. The tier affects:

- **Quota limits**: 50/500/unlimited clips per month
- **Max clip count per request**: 3/10/50
- **Max source duration**: 30 min / 4 hours / 24 hours
- **Job priority**: 0 (normal) / 1 (high) / 2 (critical)
- **Worker pool**: shared-cpu / dedicated-gpu / dedicated-gpu-batch

The handler layer extracts the tier from the JWT claims and passes it into every service call. The service never reads tokens directly — it receives the tier as a parameter.
