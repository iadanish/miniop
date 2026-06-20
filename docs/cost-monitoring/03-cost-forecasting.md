# Cost Forecasting

Budget alerts tell you when you've already overspent. Cost forecasting tells you when you *will*. For MiniOp — where costs scale with video uploads, transcription minutes, AI analysis tokens, and storage growth — forecasting prevents surprise bills and helps plan infrastructure budgets weeks or months in advance.

## Why Forecasting Matters for MiniOp

MiniOp's cost structure is multi-variable:

- **Transcription**: Linear with total audio minutes uploaded
- **AI Analysis (GPT-4V)**: Linear with number of clips analyzed, varies with video complexity
- **Encoding (MediaConvert)**: Linear with total output duration
- **Storage (R2)**: Cumulative, grows daily, compounds monthly
- **Delivery (Cloudflare CDN)**: Proportional to viewer traffic, spiky

A 10-minute video costs roughly $0.02-0.05 to process. At 1,000 videos/day, that's $20-50/day. But storage compounds — month 3 costs more than month 1 even at the same upload rate. Forecasting captures this.

## Free Tier: Linear Regression on Historical Data

Start with simple trend extrapolation using your existing SQLite cost data.

### Basic Forecasting Engine

```python
# minio/forecast/simple.py
import sqlite3
import json
from datetime import datetime, timedelta
from dataclasses import dataclass

@dataclass
class ForecastResult:
    service: str
    period: str
    current_daily_avg: float
    projected_7d: float
    projected_30d: float
    trend: str          # 'increasing', 'decreasing', 'stable'
    confidence: float   # 0.0 - 1.0

class SimpleForecaster:
    def __init__(self, db_path: str = "minio_costs.db"):
        self.db_path = db_path

    def get_daily_costs(self, days: int = 30) -> list[dict]:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        try:
            rows = conn.execute("""
                SELECT date(timestamp) as day, service,
                       SUM(total_cost) as daily_cost,
                       COUNT(*) as event_count,
                       SUM(units) as total_units
                FROM cost_events
                WHERE timestamp >= date('now', ?)
                GROUP BY day, service
                ORDER BY day
            """, (f"-{days} days",)).fetchall()
            return [dict(r) for r in rows]
        finally:
            conn.close()

    def forecast_service(self, service: str, days_history: int = 30) -> ForecastResult:
        daily = self.get_daily_costs(days_history)
        service_daily = [d for d in daily if d["service"] == service]

        if len(service_daily) < 3:
            return ForecastResult(
                service=service, period="insufficient_data",
                current_daily_avg=0, projected_7d=0, projected_30d=0,
                trend="unknown", confidence=0.0
            )

        costs = [d["daily_cost"] for d in service_daily]
        n = len(costs)

        # Simple linear regression: y = mx + b
        x_mean = (n - 1) / 2
        y_mean = sum(costs) / n
        numerator = sum((i - x_mean) * (c - y_mean) for i, c in enumerate(costs))
        denominator = sum((i - x_mean) ** 2 for i in range(n))
        slope = numerator / denominator if denominator != 0 else 0
        intercept = y_mean - slope * x_mean

        # Project forward
        current_daily = sum(costs[-7:]) / min(7, len(costs[-7:]))
        projected_7d = sum(intercept + slope * (n + i) for i in range(7))
        projected_30d = sum(intercept + slope * (n + i) for i in range(30))

        # Calculate R² for confidence
        ss_res = sum((c - (intercept + slope * i)) ** 2 for i, c in enumerate(costs))
        ss_tot = sum((c - y_mean) ** 2 for c in costs)
        r_squared = 1 - (ss_res / ss_tot) if ss_tot > 0 else 0

        # Determine trend
        if slope > current_daily * 0.02:
            trend = "increasing"
        elif slope < -current_daily * 0.02:
            trend = "decreasing"
        else:
            trend = "stable"

        return ForecastResult(
            service=service,
            period=f"last_{days_history}_days",
            current_daily_avg=round(current_daily, 4),
            projected_7d=round(max(0, projected_7d), 4),
            projected_30d=round(max(0, projected_30d), 4),
            trend=trend,
            confidence=round(max(0, min(1, r_squared)), 3),
        )

    def forecast_all(self) -> list[ForecastResult]:
        daily = self.get_daily_costs(30)
        services = set(d["service"] for d in daily)
        return [self.forecast_service(s) for s in services]

    def forecast_total(self) -> dict:
        forecasts = self.forecast_all()
        return {
            "current_daily_avg": sum(f.current_daily_avg for f in forecasts),
            "projected_7d": sum(f.projected_7d for f in forecasts),
            "projected_30d": sum(f.projected_30d for f in forecasts),
            "by_service": {f.service: {
                "daily_avg": f.current_daily_avg,
                "projected_30d": f.projected_30d,
                "trend": f.trend,
                "confidence": f.confidence,
            } for f in forecasts},
        }
```

### Usage Example

```python
from minio.forecast.simple import SimpleForecaster

forecaster = SimpleForecaster()
total = forecaster.forecast_total()

print(f"Current daily spend: ${total['current_daily_avg']:.2f}")
print(f"Projected 30-day spend: ${total['projected_30d']:.2f}")
print()
for service, data in total["by_service"].items():
    print(f"  {service}: ${data['daily_avg']:.4f}/day → ${data['projected_30d']:.2f}/30d ({data['trend']}, R²={data['confidence']})")
```

## Volume-Based Forecasting

Linear regression on cost alone misses the relationship between usage volume and cost. Model costs as a function of input volume.

```python
# minio/forecast/volume.py
import sqlite3
from dataclasses import dataclass

@dataclass
class VolumeForecast:
    metric: str           # 'videos_processed', 'audio_minutes', 'storage_gb'
    current_rate: float   # units per day
    cost_per_unit: float  # average cost per unit
    projected_volume_30d: float
    projected_cost_30d: float

class VolumeForecaster:
    def __init__(self, db_path: str = "minio_costs.db"):
        self.db_path = db_path

    def get_daily_volumes(self, days: int = 30) -> list[dict]:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        try:
            rows = conn.execute("""
                SELECT date(timestamp) as day,
                       COUNT(DISTINCT request_id) as video_count,
                       SUM(CASE WHEN service = 'openai_whisper' THEN units ELSE 0 END) as audio_seconds,
                        SUM(CASE WHEN service = 'r2_storage' THEN units ELSE 0 END) as storage_gb,
                       SUM(total_cost) as total_cost
                FROM cost_events
                WHERE timestamp >= date('now', ?)
                GROUP BY day
                ORDER BY day
            """, (f"-{days} days",)).fetchall()
            return [dict(r) for r in rows]
        finally:
            conn.close()

    def forecast_by_volume(self) -> dict:
        volumes = self.get_daily_volumes(30)
        if len(volumes) < 7:
            return {"error": "insufficient_data", "days_available": len(volumes)}

        # Calculate rates (7-day rolling average)
        recent = volumes[-7:]
        avg_videos = sum(d["video_count"] for d in recent) / len(recent)
        avg_audio = sum(d["audio_seconds"] for d in recent) / len(recent)
        avg_cost = sum(d["total_cost"] for d in recent) / len(recent)

        # Calculate unit costs
        total_videos = sum(d["video_count"] for d in volumes)
        total_cost = sum(d["total_cost"] for d in volumes)
        cost_per_video = total_cost / total_videos if total_videos > 0 else 0

        # Storage is cumulative — model growth rate
        storage_values = [d["storage_gb"] for d in volumes if d["storage_gb"] > 0]
        if len(storage_values) >= 2:
            daily_storage_growth = (storage_values[-1] - storage_values[0]) / len(storage_values)
        else:
            daily_storage_growth = 0

        # Storage cost compounds: cost = growth_rate * days * price_per_gb * avg_age_factor
        storage_cost_per_gb = 0.015  # R2 standard
        projected_storage_30d = daily_storage_growth * 30
        # Approximate: each day's storage lives for remaining days
        storage_cost_30d = sum(
            daily_storage_growth * storage_cost_per_gb * (30 - d) / 30
            for d in range(30)
        )

        return {
            "current_rates": {
                "videos_per_day": round(avg_videos, 1),
                "audio_minutes_per_day": round(avg_audio / 60, 1),
                "cost_per_video": round(cost_per_video, 4),
                "daily_storage_growth_gb": round(daily_storage_growth, 2),
            },
            "projections_30d": {
                "videos": round(avg_videos * 30),
                "processing_cost": round(avg_cost * 30, 2),
                "storage_cost": round(storage_cost_30d, 2),
                "total_cost": round(avg_cost * 30 + storage_cost_30d, 2),
                "total_storage_gb": round(daily_storage_growth * 30, 2),
            },
            "breakeven": {
                "cost_per_video": round(cost_per_video, 4),
                "videos_to_break_even_at_50_month": round(50 / cost_per_video) if cost_per_video > 0 else None,
                "videos_to_break_even_at_100_month": round(100 / cost_per_video) if cost_per_video > 0 else None,
            },
        }
```

## Production: PostgreSQL-Based Forecasting with Statistical Models

For production deployments, use PostgreSQL for historical data and scipy for more robust statistical models.

### Advanced Forecasting with scipy

```python
# minio/forecast/advanced.py
import numpy as np
from scipy import stats
from datetime import datetime, timedelta
import psycopg2

class ProductionForecaster:
    def __init__(self, pg_dsn: str):
        self.dsn = pg_dsn

    def _query(self, sql: str, params: tuple = ()) -> list[dict]:
        conn = psycopg2.connect(self.dsn)
        try:
            with conn.cursor() as cur:
                cur.execute(sql, params)
                cols = [d[0] for d in cur.description]
                return [dict(zip(cols, row)) for row in cur.fetchall()]
        finally:
            conn.close()

    def get_cost_series(self, service: str, days: int = 90) -> tuple[np.ndarray, np.ndarray]:
        rows = self._query("""
            SELECT date(timestamp) as day, SUM(total_cost) as daily_cost
            FROM cost_events
            WHERE service = %s AND timestamp >= NOW() - INTERVAL '%s days'
            GROUP BY day ORDER BY day
        """, (service, days))
        x = np.arange(len(rows))
        y = np.array([r["daily_cost"] for r in rows])
        return x, y

    def forecast_with_confidence(self, service: str, horizon_days: int = 30, confidence: float = 0.95) -> dict:
        x, y = self.get_cost_series(service, days=90)

        if len(x) < 14:
            return {"error": "insufficient_data", "days": len(x)}

        # Fit linear regression
        slope, intercept, r_value, p_value, std_err = stats.linregress(x, y)

        # Project forward
        future_x = np.arange(len(x), len(x) + horizon_days)
        predicted = intercept + slope * future_x

        # Prediction interval
        n = len(x)
        x_mean = np.mean(x)
        se = np.sqrt(np.sum((y - (intercept + slope * x)) ** 2) / (n - 2))
        t_val = stats.t.ppf((1 + confidence) / 2, n - 2)

        prediction_intervals = []
        for xi in future_x:
            se_pred = se * np.sqrt(1 + 1/n + (xi - x_mean)**2 / np.sum((x - x_mean)**2))
            margin = t_val * se_pred
            prediction_intervals.append({
                "lower": max(0, (intercept + slope * xi) - margin),
                "upper": (intercept + slope * xi) + margin,
            })

        # Detect changepoints (simple: compare recent 7d vs prior 7d)
        if len(y) >= 14:
            recent_avg = np.mean(y[-7:])
            prior_avg = np.mean(y[-14:-7])
            pct_change = (recent_avg - prior_avg) / prior_avg * 100 if prior_avg > 0 else 0
        else:
            pct_change = 0

        return {
            "service": service,
            "model": "linear_regression",
            "horizon_days": horizon_days,
            "confidence_level": confidence,
            "metrics": {
                "r_squared": round(r_value**2, 4),
                "p_value": round(p_value, 6),
                "slope_per_day": round(slope, 6),
                "recent_7d_change_pct": round(pct_change, 1),
            },
            "forecast": [
                {
                    "day": i + 1,
                    "predicted_cost": round(max(0, predicted[i]), 4),
                    "lower_bound": round(prediction_intervals[i]["lower"], 4),
                    "upper_bound": round(prediction_intervals[i]["upper"], 4),
                }
                for i in range(horizon_days)
            ],
            "summary": {
                "projected_total": round(max(0, sum(predicted)), 2),
                "projected_daily_avg": round(max(0, np.mean(predicted)), 4),
                "current_daily_avg": round(float(np.mean(y[-7:])), 4),
            },
        }

    def forecast_storage_growth(self, days_ahead: int = 90) -> dict:
        """Forecast S3 storage costs with compound growth."""
        rows = self._query("""
            SELECT date(timestamp) as day, MAX(cumulative_gb) as storage_gb
            FROM (
                SELECT timestamp,
                       SUM(SUM(units)) OVER (ORDER BY date(timestamp)) as cumulative_gb
                FROM cost_events
                WHERE service = 'r2_storage'
                GROUP BY date(timestamp), timestamp
            ) sub
            GROUP BY day ORDER BY day
        """)

        if len(rows) < 7:
            return {"error": "insufficient_storage_data"}

        storage = [r["storage_gb"] for r in rows]
        x = np.arange(len(storage))

        # Fit exponential growth: storage = a * e^(bx)
        log_storage = np.log(np.array(storage) + 0.001)
        slope, intercept, r_value, _, _ = stats.linregress(x, log_storage)

        # Project
        future_x = np.arange(len(x), len(x) + days_ahead)
        projected_gb = np.exp(intercept + slope * future_x)

        # Cost projection (R2 pricing)
        storage_price_per_gb = 0.015
        projected_cost = projected_gb * storage_price_per_gb

        return {
            "current_storage_gb": round(storage[-1], 2),
            "daily_growth_rate_pct": round(slope * 100, 2),
            "r_squared": round(r_value**2, 4),
            "projections": {
                "30d": {"storage_gb": round(float(projected_gb[min(29, len(projected_gb)-1)]), 2),
                        "monthly_cost": round(float(sum(projected_cost[:30])), 2)},
                "60d": {"storage_gb": round(float(projected_gb[min(59, len(projected_gb)-1)]), 2),
                        "monthly_cost": round(float(sum(projected_cost[:60])), 2)},
                "90d": {"storage_gb": round(float(projected_gb[min(89, len(projected_gb)-1)]), 2),
                        "monthly_cost": round(float(sum(projected_cost[:90])), 2)},
            },
        }
```

### Forecast API Endpoint

```python
# minio/api/forecast.py
from fastapi import APIRouter, Query
from minio.forecast.advanced import ProductionForecaster

router = APIRouter(prefix="/forecast", tags=["forecast"])
forecaster = ProductionForecaster(pg_dsn="postgresql://minio:pass@localhost/minio")

@router.get("/costs")
async def get_cost_forecast(
    horizon: int = Query(default=30, ge=7, le=180),
    service: str = Query(default=None),
):
    if service:
        return forecaster.forecast_with_confidence(service, horizon_days=horizon)

    services = ["openai_whisper", "openai_gpt4v", "cloudflare_stream", "r2_storage", "cloudflare_cdn"]
    results = {}
    total_projected = 0
    for svc in services:
        result = forecaster.forecast_with_confidence(svc, horizon_days=horizon)
        if "error" not in result:
            results[svc] = result["summary"]
            total_projected += result["summary"]["projected_total"]
        else:
            results[svc] = result

    return {
        "horizon_days": horizon,
        "total_projected_cost": round(total_projected, 2),
        "by_service": results,
    }

@router.get("/storage")
async def get_storage_forecast(days: int = Query(default=90, ge=30, le=365)):
    return forecaster.forecast_storage_growth(days_ahead=days)
```

### Scheduled Forecast Reports

```python
# minio/forecast/report.py
"""Run weekly: generates forecast report and stores it."""
import json
from datetime import datetime
from minio.forecast.advanced import ProductionForecaster

def generate_weekly_report(pg_dsn: str) -> dict:
    forecaster = ProductionForecaster(pg_dsn)

    services = ["openai_whisper", "openai_gpt4v", "cloudflare_stream", "r2_storage", "cloudflare_cdn"]
    report = {
        "generated_at": datetime.utcnow().isoformat(),
        "horizon_days": 30,
        "services": {},
        "storage": forecaster.forecast_storage_growth(90),
    }

    total_current = 0
    total_projected = 0

    for svc in services:
        forecast = forecaster.forecast_with_confidence(svc, horizon_days=30)
        if "error" not in forecast:
            report["services"][svc] = forecast
            total_current += forecast["summary"]["current_daily_avg"]
            total_projected += forecast["summary"]["projected_total"]

    report["totals"] = {
        "current_daily_avg": round(total_current, 2),
        "projected_30d": round(total_projected, 2),
        "projected_monthly_run_rate": round(total_current * 30, 2),
    }

    # Save report
    filename = f"forecast_report_{datetime.utcnow().strftime('%Y%m%d')}.json"
    with open(f"reports/{filename}", "w") as f:
        json.dump(report, f, indent=2, default=str)

    return report
```

## Grafana Dashboard Queries

Visualize forecasts alongside actuals in Grafana.

```sql
-- Actual daily cost (time series)
SELECT
    date(timestamp) as time,
    service,
    SUM(total_cost) as daily_cost
FROM cost_events
WHERE $__timeFilter(timestamp)
GROUP BY time, service
ORDER BY time;

-- 7-day moving average (overlay)
SELECT
    date(timestamp) as time,
    service,
    AVG(SUM(total_cost)) OVER (
        PARTITION BY service
        ORDER BY date(timestamp)
        ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
    ) as moving_avg_7d
FROM cost_events
WHERE $__timeFilter(timestamp)
GROUP BY date(timestamp), service;

-- Storage growth curve
SELECT
    date(timestamp) as time,
    SUM(SUM(units)) OVER (ORDER BY date(timestamp)) as cumulative_gb
FROM cost_events
WHERE service = 'r2_storage' AND $__timeFilter(timestamp)
GROUP BY date(timestamp)
ORDER BY time;

-- Cost per video trend
SELECT
    date(timestamp) as time,
    SUM(total_cost) / COUNT(DISTINCT request_id) as cost_per_video,
    COUNT(DISTINCT request_id) as video_count
FROM cost_events
WHERE $__timeFilter(timestamp)
GROUP BY date(timestamp)
ORDER BY time;
```

## What-If Analysis

Model cost impact of pricing changes, user growth, or feature changes.

```python
# minio/forecast/whatif.py
def what_if_pricing_change(
    current_forecast: dict,
    service: str,
    price_change_pct: float,
) -> dict:
    """Model the impact of a price change on 30-day costs."""
    if service not in current_forecast.get("by_service", {}):
        return {"error": f"Service {service} not in forecast"}

    svc_data = current_forecast["by_service"][service]
    original_30d = svc_data.get("projected_30d", 0)
    adjusted_30d = original_30d * (1 + price_change_pct / 100)

    total_original = current_forecast.get("projected_30d", 0)
    total_adjusted = total_original - original_30d + adjusted_30d

    return {
        "scenario": f"{service} price {'+'if price_change_pct > 0 else ''}{price_change_pct}%",
        "service_impact": {
            "original_30d": round(original_30d, 2),
            "adjusted_30d": round(adjusted_30d, 2),
            "difference": round(adjusted_30d - original_30d, 2),
        },
        "total_impact": {
            "original_30d": round(total_original, 2),
            "adjusted_30d": round(total_adjusted, 2),
            "difference": round(total_adjusted - total_original, 2),
        },
    }

def what_if_volume_change(
    current_forecast: dict,
    volume_change_pct: float,
) -> dict:
    """Model the impact of user/upload growth on costs."""
    total = current_forecast.get("projected_30d", 0)
    adjusted = total * (1 + volume_change_pct / 100)

    return {
        "scenario": f"Volume {'+' if volume_change_pct > 0 else ''}{volume_change_pct}%",
        "current_30d_forecast": round(total, 2),
        "adjusted_30d_forecast": round(adjusted, 2),
        "additional_cost": round(adjusted - total, 2),
    }
```

## Forecast Accuracy Tracking

Track how accurate your forecasts were to improve the model over time.

```sql
-- Store forecasts for accuracy measurement
CREATE TABLE forecast_snapshots (
    id SERIAL PRIMARY KEY,
    generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    service TEXT NOT NULL,
    horizon_days INT NOT NULL,
    projected_cost DOUBLE PRECISION NOT NULL,
    model TEXT NOT NULL DEFAULT 'linear_regression'
);

-- Compare forecast vs actual (run monthly)
CREATE VIEW forecast_accuracy AS
SELECT
    f.service,
    f.generated_at,
    f.horizon_days,
    f.projected_cost as forecasted,
    COALESCE(a.actual_cost, 0) as actual,
    ABS(f.projected_cost - COALESCE(a.actual_cost, 0)) as absolute_error,
    CASE WHEN f.projected_cost > 0
        THEN ABS(f.projected_cost - COALESCE(a.actual_cost, 0)) / f.projected_cost * 100
        ELSE 0 END as pct_error
FROM forecast_snapshots f
LEFT JOIN (
    SELECT service, SUM(total_cost) as actual_cost
    FROM cost_events
    WHERE timestamp >= NOW() - INTERVAL '30 days'
    GROUP BY service
) a ON f.service = a.service
WHERE f.generated_at >= NOW() - INTERVAL '60 days'
ORDER BY f.service, f.generated_at;
```

## Free Tier vs Production Summary

| Aspect | Free Tier | Production |
|--------|-----------|------------|
| Model | Linear regression (manual) | scipy stats + prediction intervals |
| Data source | SQLite queries | PostgreSQL + TimescaleDB |
| Storage forecast | Exponential curve | Compound growth model |
| Confidence | R² only | R² + p-value + prediction intervals |
| What-if analysis | Manual calculation | API-driven scenarios |
| Accuracy tracking | None | forecast_snapshots + accuracy view |
| Visualization | Print/console | Grafana dashboards |
| Report generation | On-demand | Weekly automated + email |
| Horizon | 7-30 days | Up to 180 days with confidence bands |
